import raw from "@/public/library.json";
import type { Library } from "./types";

/**
 * Loads the pipeline's output. Server-only: import this from server components
 * (app/page.tsx, app/layout.tsx). Client components must take the trimmed
 * GalleryPayload as a prop instead, or the whole library would be duplicated
 * into the browser bundle - see lib/types.ts.
 *
 * This is a build-time import rather than a runtime `fs` read or a client
 * `fetch`: it makes the page fully static, so Vercel serves it straight from the
 * CDN with no filesystem access and no request waterfall. The trade-off is that
 * editing library.json requires a rebuild - fine for a generated gallery.
 */
const parsed = raw as unknown as Library;

/**
 * Throws a readable error instead of letting a missing pipeline run surface as a
 * confusing build failure deep inside a component.
 */
function assertUsable(value: Library): Library {
  if (!value || !Array.isArray(value.topics) || value.topics.length === 0) {
    throw new Error(
      "library.json contains no topics. Generate it first:\n" +
        "  python -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt\n" +
        "  .venv/bin/python pipeline/pipeline.py\n" +
        "See pipeline/README.md."
    );
  }
  return value;
}

export const library: Library = assertUsable(parsed);
