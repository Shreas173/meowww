# Math Book Site

A dark editorial gallery of 635 mathematics books: vertical scroll mapped to
horizontal travel across topic "chapter screens", with the covers rendered as a 3D
wall in a fixed WebGL canvas.

Two phases, two directories:

```
pipeline/   Python. Reads the PDFs, renders covers, writes library.json.
web/        Next.js. The gallery. Deployed to Vercel.
```

## Quick start

```bash
# 1. Phase 1 — generate the assets (writes into web/public/)
python3 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
cp pipeline/.env.example pipeline/.env        # DeepSeek key, optional
.venv/bin/python pipeline/pipeline.py --dry-run
.venv/bin/python pipeline/pipeline.py

# 2. Phase 2 — run the gallery
cd web && npm install && npm run dev
```

Deploying: import the repo on Vercel and set **Root Directory** to `web`. Commit
`web/public/` — Vercel never sees the PDFs and cannot run the pipeline.

See [pipeline/README.md](pipeline/README.md) and [web/README.md](web/README.md).

## What is in this repository right now

The book collection is **635 mathematics PDFs (9 GB)** organised as
`<extraction-root>/Mathematics/<Topic>/[<Subtopic>]/book.pdf`, spread across four
archive-extraction roots that the pipeline merges into **31 topics**. The PDFs are
gitignored; the generated covers are not.

Two things are deliberately left unconfigured, because both need credentials I do
not have:

- **Metadata** is filename-derived (`"generated": false`). Add a `DEEPSEEK_API_KEY`
  and re-run to get real titles, authors and per-book colours (~$0.55, and the
  cache means you only pay for books it has not seen).

A note on the input: 69 of the 635 books are image-only scans with no text layer.
The pipeline flags them `ocr-needed` rather than guessing.
