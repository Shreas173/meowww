#!/usr/bin/env python3
"""Phase 1 - local PDF -> web asset pipeline.

Walks a tree of PDFs organised as ``<root>/<Topic>[/<Subtopic>]/book.pdf`` and emits
everything Phase 2 needs:

    <out>/library.json                       topic + book metadata
    <out>/covers/<id>.jpg                    high-quality page-1 render (DOM / detail view)
    <out>/covers/thumbs/<id>.webp            downscaled render (WebGL texture)
    .cache/topic-colors.generated.json       per-topic colours, copy -> topic-colors.json to override
    .cache/errors.json                       unreadable files, never shipped to <out>

Metadata (title / author / quote / summary / color) comes from the DeepSeek chat
completions API. Results are cached on disk, so re-runs only pay for new PDFs.

Architecture note
-----------------
All MuPDF work happens in a single supervised *renderer subprocess*. MuPDF is native
code: a malformed PDF can segfault the interpreter, which no ``try/except`` can catch,
and concurrent rendering of many documents across threads is not reliably safe. Doing
the native work in one child process means a crash costs exactly one book instead of
the whole run, and the child is forked before any threads exist, so the fork is safe.
Network enrichment (the slow part) still runs concurrently in the parent.

Run ``python pipeline.py --help`` for all options.
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import hashlib
import json
import logging
import multiprocessing
import os
import random
import re
import sys
import threading
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

# PyMuPDF renamed the import to `pymupdf` in 1.24; `fitz` still works but warns.
try:  # pragma: no cover - trivial import shim
    import pymupdf as fitz
except ImportError:  # pragma: no cover
    import fitz  # type: ignore[no-redef]

import requests
from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont

LOG = logging.getLogger("pipeline")

# Bump when the prompt or the response schema changes, to invalidate the cache.
PROMPT_VERSION = "1"
SCHEMA_VERSION = 1

# Directory names that are never part of the book collection. `books-root`
# defaults to the repo root, which also contains this pipeline and the web app.
DEFAULT_EXCLUDES = (
    ".git",
    ".venv",
    "node_modules",
    ".next",
    "__pycache__",
    "pipeline",
    "web",
    "public",
)

# Matches archive-extraction wrapper directories such as
# "Mathematics-20260923T125700Z-1-001" so a collection split over several
# extraction roots collapses into one set of topics.
WRAPPER_RE = re.compile(r"^.*-\d{8}T\d{6}Z(?:-\d+)*-\d+$")

HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

# Cheap, deterministic dark palette used when the API is unavailable, keyed by
# topic so every book in a topic shares a coherent fallback colour.
FALLBACK_PALETTE = (
    "#0d1b2a",
    "#1b1410",
    "#101c17",
    "#1a1020",
    "#0f1722",
    "#20140f",
    "#141a26",
    "#0b1d1c",
    "#1d1a10",
    "#16121e",
)

DEFAULT_PRICE_IN = 0.27
DEFAULT_PRICE_OUT = 1.10
ESTIMATED_OUTPUT_TOKENS = 320

try:
    _FORK_CONTEXT: multiprocessing.context.BaseContext | None = multiprocessing.get_context("fork")
except ValueError:  # pragma: no cover - Windows
    _FORK_CONTEXT = None


# --------------------------------------------------------------------------- #
# Small utilities
# --------------------------------------------------------------------------- #


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return re.sub(r"-{2,}", "-", value).strip("-") or "untitled"


def stable_id(rel_path: str) -> str:
    return hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:8]


# Values that ship in .env.example. Treating them as "set" sends a pointless
# request that fails with a 401, which reads like a broken key rather than an
# untouched template.
PLACEHOLDER_VALUES = frozenset({"sk-your-key-here"})


def is_placeholder(value: str) -> bool:
    """True when a credential is unset or still holds the example value."""
    text = (value or "").strip()
    return not text or text in PLACEHOLDER_VALUES


def atomic_write_text(path: Path, text: str) -> None:
    """Write via a temp file + rename so a crash never leaves a truncated JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def rgb_to_hex(rgb: Sequence[float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c))):02x}" for c in rgb)


def _srgb_to_linear(channel: float) -> float:
    channel /= 255.0
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(channel: float) -> float:
    channel = max(0.0, min(1.0, channel))
    value = channel * 12.92 if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055
    return value * 255.0


def relative_luminance(rgb: Sequence[float]) -> float:
    """WCAG relative luminance, 0 (black) .. 1 (white)."""
    r, g, b = (_srgb_to_linear(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ensure_dark(value: str, max_luminance: float = 0.30) -> str:
    """Return a valid dark 6-digit hex, darkening until it clears the threshold.

    The model occasionally returns a mid-tone that would wash out white text.
    Rather than discarding it we scale it down deterministically.
    """
    if not isinstance(value, str) or not HEX_RE.match(value.strip()):
        return "#0d1b2a"
    rgb = list(hex_to_rgb(value.strip()))
    for _ in range(24):
        if relative_luminance(rgb) <= max_luminance:
            break
        rgb = [c * 0.88 for c in rgb]
    return rgb_to_hex(rgb)


def blend_colors(values: Iterable[str], max_luminance: float = 0.16) -> str:
    """Average colours in linear light (perceptually sane), then clamp dark."""
    linear = [0.0, 0.0, 0.0]
    count = 0
    for value in values:
        if not isinstance(value, str) or not HEX_RE.match(value.strip()):
            continue
        for i, channel in enumerate(hex_to_rgb(value.strip())):
            linear[i] += _srgb_to_linear(channel)
        count += 1
    if not count:
        return "#0d1b2a"
    averaged = [_linear_to_srgb(total / count) for total in linear]
    return ensure_dark(rgb_to_hex(averaged), max_luminance=max_luminance)


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class BookSource:
    rel_path: str  # POSIX path relative to books_root
    abs_path: Path
    topic: str
    subtopic: str | None
    book_id: str

    @property
    def filename(self) -> str:
        return self.abs_path.name


@dataclass(slots=True)
class Failure:
    rel_path: str
    stage: str
    error_type: str
    message: str


@dataclass(slots=True)
class BookAnalysis:
    """Result of the native stage: everything known before enrichment."""

    source: BookSource
    pages: int
    text: str
    cover_page: int | None
    cover_ok: bool
    failures: list[Failure]


def _iter_pdfs(books_root: Path, excludes: set[str]) -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(books_root):
        # Prune in place so we never descend into node_modules / output dirs.
        dirnames[:] = [d for d in dirnames if d not in excludes and not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            if name.lower().endswith(".pdf"):
                found.append(Path(dirpath) / name)
    return found


def _relative_dir_parts(pdf: Path, books_root: Path) -> list[str]:
    rel = pdf.relative_to(books_root)
    return [p for p in rel.parent.parts if p not in (".", "")]


def _strip_wrappers(parts: Sequence[str]) -> list[str]:
    return [p for p in parts if not WRAPPER_RE.match(p)]


def detect_collection(pdfs: Sequence[Path], books_root: Path) -> str | None:
    """Infer the shared container directory that sits above the Topic level.

    Handles both ``<root>/Mathematics/<Topic>/x.pdf`` (container present) and
    ``<root>/<Topic>/x.pdf`` (no container). Returns None when there is no
    single dominant container, in which case the first directory *is* the Topic.
    """
    if not pdfs:
        return None
    firsts: Counter[str] = Counter()
    deeper = 0
    for pdf in pdfs:
        parts = _strip_wrappers(_relative_dir_parts(pdf, books_root))
        if not parts:
            continue
        firsts[parts[0]] += 1
        if len(parts) >= 2:
            deeper += 1
    if not firsts:
        return None
    name, count = firsts.most_common(1)[0]
    total = sum(firsts.values())
    # Only treat it as a container if most books live under it AND most books
    # still have a further level to use as the Topic.
    if count / total >= 0.6 and deeper / total >= 0.6:
        return name
    return None


def discover(
    books_root: Path,
    collection: str | None,
    excludes: set[str],
) -> tuple[list[BookSource], list[Failure]]:
    pdfs = _iter_pdfs(books_root, excludes)
    failures: list[Failure] = []

    if collection is None:
        collection = detect_collection(pdfs, books_root)
        if collection:
            LOG.info("Auto-detected collection directory: %s", collection)

    sources: list[BookSource] = []
    seen: dict[tuple[str, str], str] = {}

    for pdf in sorted(pdfs):
        rel_path = pdf.relative_to(books_root).as_posix()
        parts = _strip_wrappers(_relative_dir_parts(pdf, books_root))
        if collection and parts and parts[0] == collection:
            parts = parts[1:]
        if not parts:
            topic, subtopic = "Uncategorized", None
        else:
            topic, subtopic = parts[0], (parts[1] if len(parts) > 1 else None)

        key = (topic, pdf.name.strip().lower())
        if key in seen:
            failures.append(
                Failure(
                    rel_path=rel_path,
                    stage="discover",
                    error_type="duplicate",
                    message=f"same topic + filename as {seen[key]}; skipped",
                )
            )
            continue
        seen[key] = rel_path

        sources.append(
            BookSource(
                rel_path=rel_path,
                abs_path=pdf,
                topic=topic,
                subtopic=subtopic,
                book_id=f"{slugify(topic)}-{stable_id(rel_path)}",
            )
        )

    return sources, failures


# --------------------------------------------------------------------------- #
# Cover rendering (child-process side)
# --------------------------------------------------------------------------- #

# Guard against pathological pages (posters, fold-outs) blowing up memory.
MAX_RENDER_PIXELS = 40_000_000
QUALITY_WEBP = 78


def _pixmap_to_image(page: "fitz.Page", target_width: int, supersample: float) -> Image.Image:
    rect = page.rect
    if rect.width <= 0 or rect.height <= 0:
        raise ValueError("page has zero dimensions")
    zoom = min((target_width * supersample) / rect.width, 8.0)
    estimated = (rect.width * zoom) * (rect.height * zoom)
    if estimated > MAX_RENDER_PIXELS:
        zoom *= (MAX_RENDER_PIXELS / estimated) ** 0.5
    pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    if image.width != target_width:
        height = max(1, round(image.height * target_width / image.width))
        image = image.resize((target_width, height), Image.LANCZOS)
    return image


def _is_nearly_blank(image: Image.Image, deviation: int = 40, ratio: float = 0.0002) -> bool:
    """Conservative blank-page test.

    A page only counts as blank when essentially *nothing* deviates from its own
    background value. Sparse title pages must NOT be skipped: for an academic PDF
    the title page is usually the best cover available, so false positives here
    would actively make covers worse.
    """
    histogram = image.convert("L").histogram()
    total = sum(histogram)
    if not total:
        return True

    half = total / 2
    running = 0
    median = 0
    for value, count in enumerate(histogram):
        running += count
        if running >= half:
            median = value
            break

    low = max(0, median - deviation)
    high = min(255, median + deviation)
    outside = sum(histogram[:low]) + sum(histogram[high + 1 :])
    return outside / total < ratio


def render_cover(
    doc: "fitz.Document",
    target_width: int,
    supersample: float,
    probe_blank: bool = True,
) -> tuple[Image.Image, int]:
    """Render the front cover, skipping a blank leading page. Returns (image, page_number)."""
    candidates = [0]
    if probe_blank and doc.page_count > 1:
        candidates.append(1)

    last_error: Exception | None = None
    for index in candidates:
        try:
            image = _pixmap_to_image(doc[index], target_width, supersample)
        except Exception as exc:  # noqa: BLE001 - one bad page must not kill the book
            last_error = exc
            continue
        if index == candidates[-1] or not _is_nearly_blank(image):
            return image, index
    if last_error:
        raise last_error
    raise ValueError("no renderable page")


def save_cover(
    image: Image.Image,
    jpg_path: Path,
    webp_path: Path,
    thumb_width: int,
    quality: int,
) -> None:
    jpg_path.parent.mkdir(parents=True, exist_ok=True)
    webp_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(jpg_path, "JPEG", quality=quality, optimize=True, progressive=True, subsampling=1)

    height = max(1, round(image.height * thumb_width / image.width))
    thumb = image.resize((thumb_width, height), Image.LANCZOS)
    # method=6 is the slowest/best webp encoder setting; worth it at build time.
    thumb.save(webp_path, "WEBP", quality=QUALITY_WEBP, method=6)


def extract_text(doc: "fitz.Document", max_pages: int, max_chars: int) -> str:
    chunks: list[str] = []
    used = 0
    for index in range(min(max_pages, doc.page_count)):
        try:
            text = doc[index].get_text("text")
        except Exception:  # noqa: BLE001 - a single broken page is not fatal
            continue
        if not text:
            continue
        chunks.append(text)
        used += len(text)
        if used >= max_chars:
            break
    joined = "\n".join(chunks)
    joined = re.sub(r"[ \t]+", " ", joined)
    joined = re.sub(r"\n{3,}", "\n\n", joined)
    return joined.strip()[:max_chars]


def _analyze_pdf(job: dict[str, Any]) -> dict[str, Any]:
    """Open one PDF, render its cover and extract text. Runs inside the child.

    Must never raise in a way the parent cannot interpret, and must be the only
    place that touches MuPDF.
    """
    try:
        doc = fitz.open(job["abs_path"])
    except Exception as exc:  # noqa: BLE001 - corrupt / unreadable / non-PDF
        return {
            "ok": False,
            "error_type": type(exc).__name__,
            "error_message": str(exc)[:300],
        }

    try:
        if getattr(doc, "needs_pass", False) and not doc.authenticate(""):
            return {"ok": False, "error_type": "Encrypted", "error_message": "password required"}
        if doc.page_count <= 0:
            return {"ok": False, "error_type": "EmptyDocument", "error_message": "0 pages"}

        cover_page: int | None = None
        cover_error: dict[str, str] | None = None
        if not job["skip_covers"]:
            try:
                image, cover_page = render_cover(
                    doc,
                    job["cover_width"],
                    job["supersample"],
                    probe_blank=not job["keep_first_page"],
                )
                save_cover(
                    image,
                    Path(job["jpg_path"]),
                    Path(job["webp_path"]),
                    job["thumb_width"],
                    job["quality"],
                )
                image.close()
            except Exception as exc:  # noqa: BLE001
                cover_error = {
                    "error_type": type(exc).__name__,
                    "error_message": str(exc)[:300],
                }

        text = extract_text(doc, job["max_pages"], job["max_chars"])
        return {
            "ok": True,
            "pages": doc.page_count,
            "text": text,
            "cover_page": cover_page,
            "cover_error": cover_error,
        }
    except Exception as exc:  # noqa: BLE001 - unexpected MuPDF failure
        return {
            "ok": False,
            "error_type": type(exc).__name__,
            "error_message": str(exc)[:300],
        }
    finally:
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass


def _renderer_main(conn: Any) -> None:  # pragma: no cover - runs in a child process
    """Renderer child: consume jobs until told to stop or the parent goes away."""
    import signal

    # The parent owns Ctrl-C; the child should die with the pipe, not compete.
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    # MuPDF writes ICC/profile complaints straight to stderr. They are harmless
    # (the page still renders) but they bury the pipeline's own logging.
    try:
        fitz.TOOLS.mupdf_display_errors(False)
    except Exception:  # noqa: BLE001 - this API varies across versions
        pass

    while True:
        try:
            job = conn.recv()
        except (EOFError, OSError):
            return
        if not isinstance(job, dict) or job.get("cmd") == "stop":
            return
        try:
            result = _analyze_pdf(job)
        except BaseException as exc:  # noqa: BLE001 - last-resort shield
            result = {
                "ok": False,
                "error_type": type(exc).__name__,
                "error_message": str(exc)[:300],
            }
        try:
            conn.send(result)
        except (BrokenPipeError, OSError, ValueError):
            return


class Renderer:
    """Supervises the renderer subprocess and restarts it after a hard crash."""

    def __init__(self, timeout: float) -> None:
        assert _FORK_CONTEXT is not None
        self.timeout = timeout
        self.restarts = 0
        self.conn: Any = None
        self.process: Any = None
        self._start()

    def _start(self) -> None:
        parent_conn, child_conn = _FORK_CONTEXT.Pipe(duplex=True)
        self.conn = parent_conn
        self.process = _FORK_CONTEXT.Process(
            target=_renderer_main, args=(child_conn,), daemon=True
        )
        self.process.start()
        # The child's end must not be held open by us, or poll() never sees EOF.
        child_conn.close()

    def _kill(self) -> None:
        if self.process is not None and self.process.is_alive():
            self.process.terminate()
            self.process.join(5)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(5)
        self.process = None
        if self.conn is not None:
            try:
                self.conn.close()
            except OSError:
                pass
        self.conn = None

    def restart(self, reason: str) -> None:
        LOG.warning("Restarting renderer (%s).", reason)
        self.restarts += 1
        self._kill()
        self._start()

    def close(self) -> None:
        if self.conn is not None:
            try:
                self.conn.send({"cmd": "stop"})
            except (BrokenPipeError, OSError, ValueError):
                pass
        self._kill()

    def render(self, job: dict[str, Any]) -> dict[str, Any]:
        """Run one job in the child. Never raises; a crash comes back as ok=False."""
        try:
            self.conn.send(job)
        except (BrokenPipeError, OSError, ValueError) as exc:
            self.restart(f"send failed: {type(exc).__name__}")
            return self._crash_result("RendererCrashed", f"could not send job: {exc}")

        if not self.conn.poll(self.timeout):
            self.restart(f"timeout after {self.timeout:.0f}s")
            return self._crash_result("RenderTimeout", f"exceeded {self.timeout:.0f}s")

        try:
            result = self.conn.recv()
        except (EOFError, OSError, ValueError) as exc:
            self.restart(f"recv failed: {type(exc).__name__}")
            return self._crash_result("RendererCrashed", f"child died mid-job: {exc}")

        if not isinstance(result, dict):
            self.restart("malformed reply")
            return self._crash_result("RendererCrashed", "malformed reply from child")
        return result

    @staticmethod
    def _crash_result(error_type: str, message: str) -> dict[str, Any]:
        return {"ok": False, "error_type": error_type, "error_message": message}


class InlineRenderer:
    """Fallback used when fork is unavailable: no crash isolation, same interface."""

    def __init__(self, timeout: float) -> None:
        self.timeout = timeout
        self.restarts = 0

    def render(self, job: dict[str, Any]) -> dict[str, Any]:
        try:
            return _analyze_pdf(job)
        except BaseException as exc:  # noqa: BLE001
            return {"ok": False, "error_type": type(exc).__name__, "error_message": str(exc)[:300]}

    def close(self) -> None:
        pass


def make_placeholder_cover(
    source: BookSource,
    jpg_path: Path,
    webp_path: Path,
    cover_width: int,
    thumb_width: int,
    quality: int,
) -> bool:
    """Typographic stand-in so the wall never has a broken image.

    Used when a PDF cannot be opened or rendered at all.
    """
    height = round(cover_width * 1.5)
    try:
        image = Image.new("RGB", (cover_width, height), "#12141b")
        draw = ImageDraw.Draw(image)
        inset = round(cover_width * 0.07)
        draw.rectangle(
            [inset, inset, cover_width - inset, height - inset],
            outline="#33384a",
            width=max(1, round(cover_width * 0.003)),
        )

        title = _title_from_filename(source.filename)
        words = title.split()
        lines: list[str] = []
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if len(candidate) > 26 and line:
                lines.append(line)
                line = word
            else:
                line = candidate
        if line:
            lines.append(line)
        lines = lines[:6]

        font: Any
        font_small: Any
        try:
            size = max(12, round(cover_width * 0.062))
            font = ImageFont.load_default(size=size)
            font_small = ImageFont.load_default(size=max(10, round(cover_width * 0.032)))
        except Exception:  # noqa: BLE001 - very old Pillow
            font = ImageFont.load_default()
            font_small = font

        line_height = round(cover_width * 0.082)
        block_height = line_height * len(lines)
        y = (height - block_height) // 2
        for line in lines:
            try:
                width = draw.textlength(line, font=font)
            except Exception:  # noqa: BLE001
                width = len(line) * cover_width * 0.03
            draw.text(
                ((cover_width - width) / 2, y),
                line,
                fill="#e8e4da",
                font=font,
            )
            y += line_height

        label = (source.subtopic or source.topic).upper()
        try:
            width = draw.textlength(label, font=font_small)
        except Exception:  # noqa: BLE001
            width = len(label) * cover_width * 0.02
        draw.text(((cover_width - width) / 2, y + line_height * 0.5), label, fill="#7b8296", font=font_small)

        save_cover(image, jpg_path, webp_path, thumb_width, quality)
        image.close()
        return True
    except Exception as exc:  # noqa: BLE001 - placeholder must not break the run
        LOG.debug("Placeholder cover failed for %s: %s", source.rel_path, exc)
        return False


# --------------------------------------------------------------------------- #
# DeepSeek client
# --------------------------------------------------------------------------- #


class AuthError(RuntimeError):
    """Raised on 401/403 so the run aborts instead of burning 635 failed calls."""


SYSTEM_PROMPT = (
    "You are a meticulous bibliographic editor and typographer for an award-winning "
    "dark-mode editorial book gallery.\n"
    "Given the opening pages of a book, return ONLY a JSON object with exactly these keys:\n"
    '- "title": string - the book\'s real title.\n'
    '- "author": string - author(s), comma-separated; "Unknown" if not determinable.\n'
    '- "quote": string - ONE powerful, self-contained sentence distilling the book\'s '
    "central idea. No surrounding quotation marks, no attribution.\n"
    '- "summary": string - exactly two paragraphs separated by a single blank line, '
    "written as \\n\\n. Each paragraph is 2-4 sentences. Literary and precise: no "
    "marketing cliches, no bullet lists, no headings.\n"
    '- "color": string - one dark, elegant 6-digit hex code such as "#0d1b2a" that '
    "evokes the book's mood. It must be dark enough to sit behind white text.\n"
    "Rules: never invent a title or author you cannot support from the material. If the "
    'text is unusable, infer from the filename and set author to "Unknown". '
    "Output raw JSON only, with no markdown fences and no commentary."
)


def build_user_prompt(source: BookSource, text: str, has_text: bool) -> str:
    lines = [
        f"Topic: {source.topic}",
        f"Subtopic: {source.subtopic or '-'}",
        f"Filename: {source.filename}",
        "",
    ]
    if has_text:
        lines += ["Opening text (may be noisy OCR or a title page):", "---", text, "---"]
    else:
        lines += [
            "No extractable text was found: this PDF is most likely a scan without an "
            "OCR layer. Infer title and author from the filename and topic only, and keep "
            "the quote and summary general rather than inventing specifics.",
        ]
    return "\n".join(lines)


class DeepSeekClient:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        timeout: float = 60.0,
        retries: int = 4,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.retries = retries
        self._local = threading.local()

    @property
    def session(self) -> requests.Session:
        # requests.Session is not designed for concurrent use; one per thread.
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers.update(
                {
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                }
            )
            self._local.session = session
        return session

    def complete_json(self, source: BookSource, text: str) -> dict[str, Any]:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_user_prompt(source, text, bool(text))},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.7,
            "max_tokens": 900,
        }

        last_error: Exception | None = None
        for attempt in range(self.retries):
            try:
                response = self.session.post(
                    f"{self.base_url}/chat/completions", json=payload, timeout=self.timeout
                )
            except requests.RequestException as exc:
                last_error = exc
                self._sleep(attempt, None)
                continue

            if response.status_code in (401, 403):
                raise AuthError(
                    f"DeepSeek rejected the credentials (HTTP {response.status_code}). "
                    "Check DEEPSEEK_API_KEY in pipeline/.env."
                )
            if response.status_code == 429 or response.status_code >= 500:
                last_error = RuntimeError(f"HTTP {response.status_code}: {response.text[:200]}")
                self._sleep(attempt, response.headers.get("Retry-After"))
                continue
            if response.status_code >= 400:
                # 400s (bad request / context length) will not fix themselves.
                raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")

            try:
                content = response.json()["choices"][0]["message"]["content"]
            except (KeyError, IndexError, ValueError) as exc:
                last_error = RuntimeError(f"unexpected response shape: {exc}")
                self._sleep(attempt, None)
                continue

            try:
                return parse_model_json(content)
            except ValueError as exc:
                last_error = exc
                self._sleep(attempt, None)

        raise RuntimeError(f"DeepSeek call failed after {self.retries} attempts: {last_error}")

    def probe(self) -> None:
        """One cheap request so bad credentials fail fast instead of 635 times."""
        response = self.session.post(
            f"{self.base_url}/chat/completions",
            json={
                "model": self.model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1,
            },
            timeout=self.timeout,
        )
        if response.status_code in (401, 403):
            raise AuthError(
                f"DeepSeek rejected the credentials (HTTP {response.status_code}). "
                "Check DEEPSEEK_API_KEY in pipeline/.env."
            )
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:200]}")

    @staticmethod
    def _sleep(attempt: int, retry_after: str | None) -> None:
        if retry_after:
            try:
                time.sleep(min(float(retry_after), 60.0))
                return
            except ValueError:
                pass
        time.sleep(min(2**attempt, 16) + random.uniform(0, 0.75))


def parse_model_json(content: str) -> dict[str, Any]:
    """Tolerate markdown fences or stray prose around the JSON object."""
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            raise ValueError("response contained no JSON object") from None
        parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise ValueError("response JSON was not an object")
    return parsed


def normalize_metadata(raw: dict[str, Any], source: BookSource) -> dict[str, Any]:
    """Coerce the model's answer into the shipped schema, repairing what we can."""
    title = str(raw.get("title") or "").strip() or _title_from_filename(source.filename)
    author = str(raw.get("author") or "").strip() or "Unknown"

    quote = str(raw.get("quote") or "").strip().strip('"').strip()
    if not quote:
        quote = f"A volume in the {source.topic} collection."

    summary = str(raw.get("summary") or "").strip()
    if not summary:
        summary = (
            "Metadata for this title could not be recovered from the document itself. "
            f"It is filed under {source.topic}.\n\n"
            "Re-run the pipeline with a working API key to generate a full description."
        )
    else:
        # Normalise to exactly two paragraphs, whatever the model produced.
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", summary) if p.strip()]
        if len(paragraphs) == 1:
            sentences = re.split(r"(?<=[.!?])\s+", paragraphs[0])
            if len(sentences) >= 4:
                midpoint = len(sentences) // 2
                paragraphs = [" ".join(sentences[:midpoint]), " ".join(sentences[midpoint:])]
        summary = "\n\n".join(paragraphs[:2])

    return {
        "title": title,
        "author": author,
        "quote": quote,
        "summary": summary,
        "color": ensure_dark(str(raw.get("color") or "")),
    }


# Download-site noise such as "Algebra by Serge Lang (1).pdf" or "(z-lib.org)".
_NOISE_RE = re.compile(
    r"\s*[\(\[]\s*(?:\d+|z-lib\.org|libgen(?:\.\w+)?|1lib|annas-archive)\s*[\)\]]\s*$",
    re.IGNORECASE,
)


def _clean_stem(filename: str) -> str:
    """Filename -> human stem, stripped of extensions and download-site noise."""
    stem = Path(filename).name
    previous = None
    while previous != stem:
        previous = stem
        if stem.lower().endswith(".pdf"):
            stem = stem[:-4]
        stem = _NOISE_RE.sub("", stem)
    return re.sub(r"[\s,;:\-]+$", "", stem).strip()


def _title_from_filename(filename: str) -> str:
    return _clean_stem(filename) or "Untitled"


def _author_from_filename(filename: str) -> str:
    match = re.search(r"\s+by\s+(.+)$", _clean_stem(filename), flags=re.IGNORECASE)
    return match.group(1).strip() if match else "Unknown"


def fallback_metadata(source: BookSource, reason: str) -> dict[str, Any]:
    """Deterministic, offline metadata, marked so it is never mistaken for real data."""
    palette_index = int(stable_id(source.topic), 16) % len(FALLBACK_PALETTE)
    return {
        "title": _title_from_filename(source.filename),
        "author": _author_from_filename(source.filename),
        "quote": f"A volume in the {source.topic} collection.",
        "summary": (
            f"{_title_from_filename(source.filename)} is catalogued under {source.topic}"
            + (f" / {source.subtopic}" if source.subtopic else "")
            + ".\n\n"
            "This entry was generated without language-model enrichment, so it carries the "
            "title and author inferred from the filename only."
        ),
        "color": FALLBACK_PALETTE[palette_index],
        "generated": False,
        "reason": reason,
    }


# --------------------------------------------------------------------------- #
# Cache
# --------------------------------------------------------------------------- #


class EnrichCache:
    """Disk cache keyed by a cheap fingerprint of the PDF, prompt and model."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def fingerprint(self, source: BookSource, model: str) -> str:
        try:
            stat = source.abs_path.stat()
            signature = f"{stat.st_size}:{stat.st_mtime_ns}"
        except OSError:
            signature = "missing"
        raw = f"{source.rel_path}|{signature}|{PROMPT_VERSION}|{model}|v{SCHEMA_VERSION}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def get(self, fingerprint: str) -> dict[str, Any] | None:
        path = self.root / f"{fingerprint}.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if payload.get("schemaVersion") != SCHEMA_VERSION:
            return None
        metadata = payload.get("metadata")
        return metadata if isinstance(metadata, dict) else None

    def put(self, fingerprint: str, metadata: dict[str, Any]) -> None:
        atomic_write_text(
            self.root / f"{fingerprint}.json",
            json.dumps(
                {"schemaVersion": SCHEMA_VERSION, "metadata": metadata},
                ensure_ascii=False,
                indent=1,
            ),
        )


# --------------------------------------------------------------------------- #
# Stage 1: native analysis (parent side, one book at a time through the child)
# --------------------------------------------------------------------------- #


def build_job(source: BookSource, args: argparse.Namespace) -> dict[str, Any]:
    out = Path(args.out)
    return {
        "abs_path": str(source.abs_path),
        "book_id": source.book_id,
        "jpg_path": str(out / "covers" / f"{source.book_id}.jpg"),
        "webp_path": str(out / "covers" / "thumbs" / f"{source.book_id}.webp"),
        "skip_covers": bool(args.skip_covers or args.no_write),
        "cover_width": args.cover_width,
        "thumb_width": args.thumb_width,
        "quality": args.quality,
        "supersample": args.supersample,
        "keep_first_page": args.keep_first_page,
        "max_pages": args.max_pages,
        "max_chars": args.max_chars,
    }


def analyze_book(
    source: BookSource,
    renderer: Any,
    args: argparse.Namespace,
) -> BookAnalysis:
    """Native stage for one book. Degrades to a placeholder cover on failure."""
    job = build_job(source, args)
    result = renderer.render(job)
    failures: list[Failure] = []

    if not result.get("ok"):
        error_type = str(result.get("error_type") or "Unknown")
        message = str(result.get("error_message") or "")[:300]
        failures.append(Failure(source.rel_path, "analyze", error_type, message))
        # A crashed worker can leave half-written images behind.
        if not job["skip_covers"]:
            for key in ("jpg_path", "webp_path"):
                stale = Path(job[key])
                try:
                    stale.unlink(missing_ok=True)
                except OSError:
                    pass
            if make_placeholder_cover(
                source,
                Path(job["jpg_path"]),
                Path(job["webp_path"]),
                args.cover_width,
                args.thumb_width,
                args.quality,
            ):
                failures.append(
                    Failure(source.rel_path, "cover", "Placeholder", "typographic stand-in used")
                )
        return BookAnalysis(
            source=source,
            pages=0,
            text="",
            cover_page=None,
            cover_ok=False,
            failures=failures,
        )

    cover_error = result.get("cover_error")
    if cover_error:
        failures.append(
            Failure(
                source.rel_path,
                "cover",
                str(cover_error.get("error_type") or "RenderError"),
                str(cover_error.get("error_message") or "")[:300],
            )
        )
        if make_placeholder_cover(
            source,
            Path(job["jpg_path"]),
            Path(job["webp_path"]),
            args.cover_width,
            args.thumb_width,
            args.quality,
        ):
            failures.append(
                Failure(source.rel_path, "cover", "Placeholder", "typographic stand-in used")
            )

    return BookAnalysis(
        source=source,
        pages=int(result.get("pages") or 0),
        text=str(result.get("text") or ""),
        cover_page=result.get("cover_page"),
        cover_ok=not cover_error,
        failures=failures,
    )


# --------------------------------------------------------------------------- #
# Stage 2: enrichment (concurrent, network-bound)
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class BookResult:
    record: dict[str, Any]
    metadata_source: str


class AuthState:
    """Thread-safe latch: the first credential failure wins and is reported once."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.error: AuthError | None = None

    def fail(self, exc: AuthError) -> None:
        with self._lock:
            if self.error is None:
                self.error = exc

    @property
    def failed(self) -> bool:
        return self.error is not None


def enrich_book(
    analysis: BookAnalysis,
    args: argparse.Namespace,
    cache: EnrichCache,
    use_api: bool,
    auth: AuthState,
) -> tuple[BookResult, list[Failure]]:
    """Cache / API / fallback for one analysed book. Never raises."""
    source = analysis.source
    failures: list[Failure] = []
    fingerprint = cache.fingerprint(source, args.model)
    metadata = None if args.force else cache.get(fingerprint)
    metadata_source = "cache" if metadata else ""

    if metadata is None:
        if use_api and not auth.failed:
            try:
                raw = args.client.complete_json(source, analysis.text)
                metadata = normalize_metadata(raw, source)
                metadata["generated"] = True
                metadata_source = "deepseek"
                cache.put(fingerprint, metadata)
            except AuthError as exc:
                # Credentials died mid-run: report once, then degrade gracefully.
                auth.fail(exc)
                metadata = fallback_metadata(source, "api-error")
                metadata_source = "filename"
            except Exception as exc:  # noqa: BLE001
                failures.append(
                    Failure(source.rel_path, "enrich", type(exc).__name__, str(exc)[:300])
                )
                metadata = fallback_metadata(source, "api-error")
                metadata_source = "filename"
        else:
            if auth.failed:
                status = "api-error"
            elif len(analysis.text) < args.min_text_chars:
                status = "ocr-needed"
            else:
                status = "no-api"
            metadata = fallback_metadata(source, status)
            metadata_source = "filename"

    extraction = "text" if len(analysis.text) >= args.min_text_chars else "ocr-needed"
    if not analysis.cover_ok:
        extraction = "unavailable" if analysis.pages == 0 else extraction

    record = {
        "id": source.book_id,
        "title": metadata["title"],
        "author": metadata["author"],
        "quote": metadata["quote"],
        "summary": metadata["summary"],
        "color": metadata["color"],
        "topic": source.topic,
        "subtopic": source.subtopic,
        "file": source.filename,
        "pages": analysis.pages,
        "cover": f"/covers/{source.book_id}.jpg",
        "thumb": f"/covers/thumbs/{source.book_id}.webp",
        "meta": {
            "source": metadata_source or "unknown",
            "generated": bool(metadata.get("generated", False)),
            "extraction": extraction,
            "chars": len(analysis.text),
        },
    }
    return BookResult(record=record, metadata_source=metadata_source or "unknown"), failures


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #


def pick_featured(books: list[dict[str, Any]]) -> dict[str, Any]:
    """Deterministic hero: the book carrying the richest generated content."""

    def score(book: dict[str, Any]) -> tuple:
        generated = bool(book["meta"].get("generated"))
        content = len(book["summary"]) + len(book["quote"])
        return (generated, content, book["title"].lower())

    return max(books, key=score)


def assemble_topics(results: list[BookResult], overrides: dict[str, str]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    subtopics: dict[str, str | None] = {}
    for result in results:
        record = result.record
        grouped.setdefault(record["topic"], []).append(record)
        subtopics[record["topic"]] = record["subtopic"]

    topics: list[dict[str, Any]] = []
    for name in sorted(grouped, key=lambda value: (-len(grouped[value]), value.lower())):
        books = sorted(grouped[name], key=lambda book: book["title"].lower())
        slug = slugify(name)
        override = overrides.get(name) or overrides.get(slug)
        color = (
            ensure_dark(override, max_luminance=0.22)
            if override
            else blend_colors([book["color"] for book in books])
        )
        topics.append(
            {
                "slug": slug,
                "name": name,
                "color": color,
                "bookCount": len(books),
                "featuredId": pick_featured(books)["id"],
                "books": books,
            }
        )
    return topics


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #


def print_plan(sources: Sequence[BookSource], args: argparse.Namespace) -> None:
    counts = Counter(source.topic for source in sources)
    print(f"\nDiscovered {len(sources)} books across {len(counts)} topics.\n")
    width = max((len(topic) for topic in counts), default=4)
    for topic, count in counts.most_common():
        print(f"  {topic.ljust(width)}  {count:>4}")

    approx_chars = sum(min(args.max_chars, args.max_pages * 2000) for _ in sources)
    input_tokens = int(approx_chars / 3.6) + 220 * len(sources)
    output_tokens = ESTIMATED_OUTPUT_TOKENS * len(sources)
    cost = (
        input_tokens / 1_000_000 * args.price_in + output_tokens / 1_000_000 * args.price_out
    )
    print(
        f"\nEstimated DeepSeek usage: ~{input_tokens / 1000:.0f}k input tokens, "
        f"~{output_tokens / 1000:.0f}k output tokens"
    )
    print(
        f"Estimated cost: ~${cost:.2f} at ${args.price_in}/M in, ${args.price_out}/M out "
        "(indicative only; cached books cost nothing)"
    )
    print("\nDry run: nothing was written.\n")


def write_errors(path: Path, failures: Sequence[Failure]) -> None:
    payload = [
        {
            "path": failure.rel_path,
            "stage": failure.stage,
            "error": failure.error_type,
            "message": failure.message,
        }
        for failure in failures
    ]
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))


def load_overrides(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        LOG.warning("Ignoring unreadable %s (%s)", path, exc)
        return {}
    if not isinstance(payload, dict):
        return {}
    return {str(k): str(v) for k, v in payload.items()}


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Turn a tree of PDFs into library.json plus web-ready cover renders.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    source = parser.add_argument_group("source")
    source.add_argument(
        "--books-root", default=str(repo_root), help="root directory containing the book tree"
    )
    source.add_argument(
        "--collection",
        default=None,
        help="container directory above the Topic level (default: auto-detect, e.g. 'Mathematics')",
    )
    source.add_argument(
        "--exclude",
        default=",".join(DEFAULT_EXCLUDES),
        help="comma-separated directory names to skip",
    )
    source.add_argument(
        "--only-topic",
        action="append",
        default=None,
        help="only process topics whose name contains this text (repeatable or comma-separated)",
    )
    source.add_argument("--limit", type=int, default=None, help="process at most N books")

    output = parser.add_argument_group("output")
    output.add_argument(
        "--out", default=str(repo_root / "web" / "public"), help="output directory (Next.js public)"
    )
    output.add_argument("--cover-width", type=int, default=1000, help="JPEG cover width in px")
    output.add_argument("--thumb-width", type=int, default=600, help="WebP thumbnail width in px")
    output.add_argument("--quality", type=int, default=82, help="JPEG quality")
    output.add_argument(
        "--supersample", type=float, default=1.5, help="render scale before downsampling"
    )
    output.add_argument("--skip-covers", action="store_true", help="skip cover rendering")
    output.add_argument(
        "--keep-first-page",
        action="store_true",
        help="always use page 1 as the cover, even if it looks blank",
    )
    output.add_argument("--no-write", action="store_true", help="process but write nothing")

    enrich = parser.add_argument_group("enrichment")
    enrich.add_argument(
        "--no-api", action="store_true", help="never call DeepSeek; derive from filenames"
    )
    enrich.add_argument(
        "--model", default=None, help="DeepSeek model (default: $DEEPSEEK_MODEL or deepseek-chat)"
    )
    enrich.add_argument("--api-base", default=None, help="DeepSeek API base URL")
    enrich.add_argument("--workers", type=int, default=6, help="parallel enrichment workers")
    enrich.add_argument("--retries", type=int, default=4, help="attempts per API call")
    enrich.add_argument("--timeout", type=float, default=60.0, help="per-request timeout in seconds")
    enrich.add_argument("--force", action="store_true", help="ignore the cache and re-enrich")
    enrich.add_argument("--max-pages", type=int, default=10, help="pages of text to extract")
    enrich.add_argument("--max-chars", type=int, default=6000, help="character cap sent to the API")
    enrich.add_argument(
        "--min-text-chars",
        type=int,
        default=400,
        help="below this, a PDF is treated as a scan with no OCR layer",
    )
    enrich.add_argument("--price-in", type=float, default=DEFAULT_PRICE_IN, help="USD per 1M input tokens")
    enrich.add_argument("--price-out", type=float, default=DEFAULT_PRICE_OUT, help="USD per 1M output tokens")

    robustness = parser.add_argument_group("robustness")
    robustness.add_argument(
        "--no-isolate",
        action="store_true",
        help="run MuPDF in-process instead of an isolated child (faster, but a malformed PDF "
        "can segfault the whole run)",
    )
    robustness.add_argument(
        "--render-timeout",
        type=float,
        default=180.0,
        help="seconds allowed per book before the renderer is restarted",
    )

    misc = parser.add_argument_group("misc")
    misc.add_argument("--dry-run", action="store_true", help="report the plan and cost, then exit")
    misc.add_argument("--topic-colors", default=None, help="JSON file of topic -> hex overrides")
    misc.add_argument("--cache-dir", default=None, help="cache directory (default: <pipeline>/.cache)")
    misc.add_argument("--quiet", action="store_true", help="only warnings and errors")
    misc.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    level = logging.WARNING if args.quiet else (logging.DEBUG if args.verbose else logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s  %(levelname)-7s %(message)s", datefmt="%H:%M:%S")

    script_dir = Path(__file__).resolve().parent
    load_dotenv(script_dir / ".env")
    load_dotenv()  # also honour a .env in the current working directory

    args.books_root = Path(args.books_root).expanduser().resolve()
    args.out = Path(args.out).expanduser().resolve()
    args.cache_dir = (
        Path(args.cache_dir).expanduser().resolve() if args.cache_dir else script_dir / ".cache"
    )
    args.model = args.model or os.environ.get("DEEPSEEK_MODEL") or "deepseek-chat"
    args.api_base = args.api_base or os.environ.get("DEEPSEEK_API_BASE") or "https://api.deepseek.com"

    if not args.books_root.is_dir():
        LOG.error("--books-root is not a directory: %s", args.books_root)
        return 2

    # --- discovery -------------------------------------------------------- #
    excludes = {name.strip() for name in args.exclude.split(",") if name.strip()}
    sources, failures = discover(args.books_root, args.collection, excludes)

    if args.only_topic:
        needles = [
            part.strip().lower()
            for entry in args.only_topic
            for part in entry.split(",")
            if part.strip()
        ]
        sources = [s for s in sources if any(needle in s.topic.lower() for needle in needles)]
    sources.sort(key=lambda s: (s.topic.lower(), s.rel_path.lower()))
    if args.limit is not None:
        sources = sources[: args.limit]

    if not sources:
        LOG.error(
            "No PDFs found under %s (excluded dirs: %s)",
            args.books_root,
            ", ".join(sorted(excludes)),
        )
        return 1

    if args.dry_run:
        print_plan(sources, args)
        return 0
    if args.no_write:
        LOG.info("--no-write: processing without emitting any files")

    # --- API availability ------------------------------------------------- #
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    use_api = not args.no_api
    if use_api and is_placeholder(api_key):
        LOG.warning(
            "%s still holds the placeholder from .env.example; ignoring it and using "
            "filename-derived metadata. Put a real key there to enrich instead.",
            "DEEPSEEK_API_KEY" if api_key else "DEEPSEEK_API_KEY (unset)",
        )
        use_api = False
    args.client = (
        DeepSeekClient(api_key, args.api_base, args.model, args.timeout, args.retries)
        if use_api
        else None
    )
    if args.client is not None:
        # Verify once, up front, rather than discovering the problem 635 times.
        # A failure here is NOT fatal: enrichment is optional and completely
        # independent of hosting the PDFs, and aborting the run would mean a
        # mistyped metadata key stops you uploading the books.
        try:
            args.client.probe()
            LOG.info("DeepSeek credentials verified (%s).", args.model)
        except AuthError as exc:
            LOG.error("%s", exc)
            LOG.error(
                "Continuing WITHOUT generated metadata: books will use their filenames. "
                "Fix the key and re-run to enrich (already-rendered covers are reused)."
            )
            use_api = False
            args.client = None
        except Exception as exc:  # noqa: BLE001
            LOG.warning(
                "Could not reach DeepSeek (%s: %s). Continuing; affected books fall back "
                "to filename-derived metadata.",
                type(exc).__name__,
                exc,
            )

    LOG.info(
        "Processing %d books across %d topics (%s)",
        len(sources),
        len({s.topic for s in sources}),
        f"enrichment via {args.model}" if use_api else "no enrichment",
    )

    # The renderer is forked BEFORE any thread exists, so the fork is safe.
    isolate = not args.no_isolate and _FORK_CONTEXT is not None
    if not isolate and not args.no_isolate:
        LOG.warning("fork() unavailable on this platform - running MuPDF in-process.")
    renderer: Any = Renderer(args.render_timeout) if isolate else InlineRenderer(args.render_timeout)
    if isolate:
        LOG.info("MuPDF isolated in a child process (crash-safe).")
    if not args.skip_covers and not args.no_write:
        LOG.info("Covers -> %s", args.out / "covers")

    cache = EnrichCache(args.cache_dir)
    stats = Counter()
    failures_local = list(failures)
    started = time.monotonic()

    # --- stage 1: native analysis (serial, isolated) ----------------------- #
    analyses: list[BookAnalysis] = []
    try:
        for index, source in enumerate(sources, start=1):
            analysis = analyze_book(source, renderer, args)
            analyses.append(analysis)
            failures_local.extend(analysis.failures)
            if not analysis.cover_ok and analysis.pages == 0:
                stats["unreadable"] += 1
            if index % 50 == 0 or index == len(sources):
                elapsed = time.monotonic() - started
                LOG.info(
                    "rendered %d/%d  (%.1f/s, %d unreadable, %d renderer restarts)",
                    index,
                    len(sources),
                    index / elapsed if elapsed else 0,
                    stats["unreadable"],
                    getattr(renderer, "restarts", 0),
                )
    except KeyboardInterrupt:
        renderer.close()
        LOG.error("Interrupted during rendering; nothing was written.")
        return 130
    finally:
        renderer.close()

    rendered_at = time.monotonic()
    LOG.info(
        "Rendering done in %.1fs; enriching %d books...",
        rendered_at - started,
        len(analyses),
    )

    # --- stage 2: enrichment (concurrent, network-bound) ------------------ #
    results: list[BookResult] = []
    auth = AuthState()

    with futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        pending = {
            pool.submit(enrich_book, analysis, args, cache, use_api, auth): analysis
            for analysis in analyses
        }
        for index, future in enumerate(futures.as_completed(pending), start=1):
            analysis = pending[future]
            try:
                result, book_failures = future.result()
            except Exception as exc:  # noqa: BLE001 - a worker bug must not lose the run
                failures_local.append(
                    Failure(analysis.source.rel_path, "worker", type(exc).__name__, str(exc)[:300])
                )
                stats["books_failed"] += 1
                continue
            failures_local.extend(book_failures)
            results.append(result)
            stats[result.metadata_source] += 1
            if index % 100 == 0 or index == len(analyses):
                LOG.info("enriched %d/%d", index, len(analyses))

    if auth.failed:
        LOG.error(
            "%s Credentials failed mid-run; the remaining books used filename-derived "
            "metadata. Re-run with a valid key - successful results are cached.",
            auth.error,
        )

    # --- assembly --------------------------------------------------------- #
    overrides_path = (
        Path(args.topic_colors).expanduser()
        if args.topic_colors
        else script_dir / "topic-colors.json"
    )
    topics = assemble_topics(results, load_overrides(overrides_path))
    duplicates = sum(1 for f in failures_local if f.stage == "duplicate")
    failed_total = stats["books_failed"] + duplicates + stats["unreadable"]

    library = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "promptVersion": PROMPT_VERSION,
        "model": args.model if use_api else None,
        "stats": {
            "topics": len(topics),
            "books": len(results),
            "generated": sum(1 for r in results if r.record["meta"]["generated"]),
            "fallback": sum(1 for r in results if not r.record["meta"]["generated"]),
            "ocrNeeded": sum(1 for r in results if r.record["meta"]["extraction"] == "ocr-needed"),
            "unreadable": stats["unreadable"],
            "failed": failed_total,
        },
        "topics": topics,
    }

    if not args.no_write:
        atomic_write_text(
            Path(args.out) / "library.json",
            json.dumps(library, ensure_ascii=False, indent=1),
        )
        write_errors(args.cache_dir / "errors.json", failures_local)
        atomic_write_text(
            args.cache_dir / "topic-colors.generated.json",
            json.dumps(
                {topic["name"]: topic["color"] for topic in topics},
                ensure_ascii=False,
                indent=2,
            ),
        )

    LOG.info(
        "Done in %.1fs - %d books, %d topics, %d from cache, %d generated, %d fallback, "
        "%d unreadable, %d failures",
        time.monotonic() - started,
        library["stats"]["books"],
        library["stats"]["topics"],
        stats["cache"],
        library["stats"]["generated"],
        library["stats"]["fallback"],
        library["stats"]["unreadable"],
        library["stats"]["failed"],
    )
    if args.no_write:
        LOG.info("--no-write: nothing was written.")
        return 0

    LOG.info("Wrote %s", Path(args.out) / "library.json")
    if failures_local:
        LOG.info("Failure log: %s", args.cache_dir / "errors.json")
    LOG.info(
        "Topic colours: %s (copy to pipeline/topic-colors.json to override)",
        args.cache_dir / "topic-colors.generated.json",
    )
    return 0



if __name__ == "__main__":
    sys.exit(main())
