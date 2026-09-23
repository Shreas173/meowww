# Phase 1 — PDF → web assets

Turns a tree of PDFs into everything the frontend needs: cover renders, a
`library.json` index, and DeepSeek-generated metadata.

## Setup

```bash
cd /path/to/Math-Book-Site
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt

cp pipeline/.env.example pipeline/.env     # then add your DEEPSEEK_API_KEY
```

The API key is optional: without it the pipeline still produces a complete,
deployable site using filename-derived metadata.

## Usage

```bash
# See the plan and the projected API cost without spending anything.
.venv/bin/python pipeline/pipeline.py --dry-run

# The full run. Writes into web/public/ by default.
.venv/bin/python pipeline/pipeline.py

# Work on one topic only.
.venv/bin/python pipeline/pipeline.py --only-topic "Real Analysis"

# Completely free run: covers + filenames, no API calls.
.venv/bin/python pipeline/pipeline.py --no-api
```

Output:

```
web/public/library.json                    the index the site renders
web/public/covers/<id>.jpg                 page-1 render, 1000px (chapter-screen hero)
web/public/covers/thumbs/<id>.webp         downscaled, 600px (WebGL texture)
pipeline/.cache/topic-colors.generated.json  per-topic colours
pipeline/.cache/errors.json                unreadable files (never shipped)
```

## How the book tree is interpreted

The layout is expected to be `<root>/<Topic>[/<Subtopic>]/book.pdf`, but two
real-world wrinkles are handled automatically:

- **Archive wrapper directories** such as `Mathematics-20260923T125700Z-1-001`
  are stripped, so a collection split across several extraction roots collapses
  into one set of topics. This library, for example, is 635 PDFs spread over four
  such roots and resolves to 31 topics.
- **A shared container level** (`Mathematics/` here) is auto-detected and
  skipped, so the first meaningful directory becomes the Topic. Point it at a
  bare `Books/Philosophy/*.pdf` tree and it works the same way.

Override the guess with `--collection` (or `--collection ""` to disable it), and
add directories to skip with `--exclude`.

## Re-runs are free

Enrichment responses are cached in `pipeline/.cache/` keyed by the PDF's size,
mtime, prompt version and model. Re-running only pays for books that are new or
have changed. Pass `--force` to ignore the cache, and bump `PROMPT_VERSION` in
`pipeline.py` when you change the prompt so old answers are invalidated.

A full run is also cheap from scratch: 635 books is roughly 1.2M input tokens and
0.2M output tokens, about $0.55 at current `deepseek-chat` rates. `--dry-run`
prints the estimate for your own library before you commit.

## Robustness

**MuPDF runs in an isolated child process.** All PDF parsing, rendering and text
extraction happen in a single supervised subprocess, and network enrichment
happens concurrently in the parent. This is not incidental:

- MuPDF is native code. A malformed PDF segfaults the interpreter, and no
  `try`/`except` can catch that. Running it in-process is how a 635-book run dies
  at book 125 and loses everything.
- Concurrent rendering of many documents across threads is not reliably safe. An
  earlier threaded version of this script crashed reproducibly; serialising the
  native work in one child fixed it, with no measurable loss because the slow
  part is the API calls, and those still run in parallel.

If the child dies mid-book, the parent records that one failure, restarts the
child, and carries on. `--no-isolate` runs in-process for speed if you trust your
library; `--render-timeout` bounds a single book.

Other failure paths, all non-fatal:

| Situation | Behaviour |
|---|---|
| Corrupt / non-PDF file | Logged to `errors.json`; gets a typographic placeholder cover |
| Password-protected PDF | Opened with an empty password, else treated as above |
| Zero-page PDF | Treated as above |
| Page 1 blank, page 2 has content | Renders page 2 (the test is deliberately conservative, so a sparse title page is *kept*) |
| Scanned PDF with no text layer | Recorded as `ocr-needed`, metadata inferred from the filename |
| HTTP 429 / 5xx | Retried with exponential backoff, honouring `Retry-After` |
| Bad API key | Detected by a preflight request before any book is processed |
| Key revoked mid-run | Remaining books fall back to filename metadata |

Every book gets a cover: books that cannot be rendered get a generated
typographic stand-in, so the site never shows a broken image.

`errors.json` is the place to look first when something is missing.

## Tuning

| Flag | Default | Notes |
|---|---|---|
| `--cover-width` | 1000 | JPEG used for the DOM hero |
| `--thumb-width` | 600 | WebP used as the WebGL texture; this is the single biggest lever on GPU memory |
| `--workers` | 6 | Concurrent enrichment requests |
| `--max-pages` / `--max-chars` | 10 / 6000 | Text sent to the API; the main cost driver |
| `--min-text-chars` | 400 | Below this a PDF counts as a scan |
| `--keep-first-page` | off | Always use page 1 as the cover |

## Design notes

- **Stable ids.** A book's id is `slug(topic)-sha1(relative path)[:8]`, so adding
  or removing books never renames existing covers.
- **Dark colours are enforced.** The model sometimes returns a mid-tone; anything
  above the luminance threshold is scaled down deterministically rather than
  discarded, so white text always stays legible.
- **Topic colours are derived,** not requested from the model: they are blended
  from the topic's book colours in linear light. The pipeline always writes
  `topic-colors.generated.json`; copy it to `pipeline/topic-colors.json` and edit
  to override by topic name or slug.
- **Placeholder covers** use Pillow's bundled font, so no system fonts are needed.

PyMuPDF is AGPL-3.0 (or commercial). That is fine for a local build script; it
only matters if you redistribute this pipeline.
