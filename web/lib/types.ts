/**
 * These types mirror the JSON emitted by pipeline/pipeline.py.
 *
 * The pipeline must stay in step with this file: adding a field there without
 * adding it here is harmless, but renaming one silently breaks the site. The
 * `schemaVersion` in library.json exists so you notice when that happens.
 */

export type MetadataSource = "deepseek" | "cache" | "filename" | "unknown";

export type ExtractionStatus = "text" | "ocr-needed" | "unavailable";

export interface BookMeta {
  /** How title/author/quote/summary/color were obtained. */
  source: MetadataSource;
  /** False when the record is a deterministic filename-derived fallback. */
  generated: boolean;
  /** "text" = real text layer, "ocr-needed" = scan, "unavailable" = unreadable PDF. */
  extraction: ExtractionStatus;
  /** Characters of text that were extracted and sent for enrichment. */
  chars: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  /** One powerful sentence. */
  quote: string;
  /** Exactly two paragraphs, separated by a blank line. */
  summary: string;
  /** Dark hex used behind the cover plane. */
  color: string;
  topic: string;
  subtopic: string | null;
  /** Original filename, kept for provenance. */
  file: string;
  pages: number;
  /** High-resolution JPEG under /covers/ - used for the DOM hero. */
  cover: string;
  /** Downscaled WebP under /covers/thumbs/ - used as the WebGL texture. */
  thumb: string;
  meta: BookMeta;
}

export interface Topic {
  slug: string;
  name: string;
  /** Dark hex blended from the topic's books; drives the background crossfade. */
  color: string;
  bookCount: number;
  /** id of the book chosen as this topic's hero. */
  featuredId: string;
  books: Book[];
}

export interface LibraryStats {
  topics: number;
  books: number;
  generated: number;
  fallback: number;
  ocrNeeded: number;
  unreadable: number;
  failed: number;
}

export interface Library {
  schemaVersion: number;
  generatedAt: string;
  promptVersion: string;
  model: string | null;
  stats: LibraryStats;
  topics: Topic[];
}

/* ---------------------------------------------------------------------------
   What actually crosses the server/client boundary.

   library.json is ~590 KB, but most of it is the two-paragraph `summary` and
   `quote` of all 635 books - and only 31 of those are ever displayed (one hero
   per topic). Sending the trimmed shape below instead cuts the RSC payload by
   roughly 4x, so the full records stay on the server.
--------------------------------------------------------------------------- */

/** Just enough of a book for the cover wall and the palette. */
export interface GalleryBook {
  id: string;
  title: string;
  author: string;
  color: string;
  /** Downscaled WebP, used as the WebGL texture. */
  thumb: string;
  /** High-resolution JPEG, used for the chapter-screen hero via next/image. */
  cover: string;
  pages: number;
}

export interface GalleryTopic {
  slug: string;
  name: string;
  color: string;
  bookCount: number;
  /** Index of this topic's hero book within `books`. */
  heroIndex: number;
  books: GalleryBook[];
}

export interface GalleryPayload {
  topics: GalleryTopic[];
}
