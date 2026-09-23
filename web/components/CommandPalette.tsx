"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { jumpTo } from "@/lib/navigation";
import { useProgressMap, useProgressReady } from "@/lib/useProgress";
import type { GalleryBook, GalleryTopic } from "@/lib/types";

interface CommandPaletteProps {
  topics: GalleryTopic[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Item =
  | { kind: "topic"; topic: GalleryTopic; score: number }
  | { kind: "book"; book: GalleryBook; topic: GalleryTopic; score: number };

/** An item plus its position in the flat list, so keyboard order and rendering
 *  agree without either of them re-deriving it. */
type Row = { item: Item; index: number };
type Section = { title: string; rows: Row[] };

/** Scoring is intentionally simple: substring, weighted by where it matches. */
function scoreText(haystack: string, needle: string): number {
  const text = haystack.toLowerCase();
  const at = text.indexOf(needle);
  if (at < 0) return 0;
  if (at === 0) return 100;
  // Word boundary beats a match in the middle of a word.
  return /[\s\-–—:,.(\[]/.test(text[at - 1]) ? 60 : 25;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="text-ink">{text.slice(at, at + query.length)}</span>
      {text.slice(at + query.length)}
    </>
  );
}

/**
 * ⌘K search over the whole library.
 *
 * With 635 books there is no browsing your way to a specific one, so this is the
 * primary navigation. It is grouped rather than flat, because the two jobs are
 * different: **Topics** is a jump list for moving around the gallery, and **Books**
 * is for finding one title. Mixed into a single list, a topic was only reachable
 * if you happened to type its name.
 *
 * ↑↓ to move, ↵ to jump the gallery to the highlighted result.
 */
export default function CommandPalette({
  topics,
  open,
  onOpenChange,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ready = useProgressReady();
  const progress = useProgressMap();

  // Flat lookup so a book id from the progress store can be resolved quickly.
  const index = useMemo(() => {
    const map = new Map<string, { book: GalleryBook; topic: GalleryTopic }>();
    for (const topic of topics) {
      for (const book of topic.books) map.set(book.id, { book, topic });
    }
    return map;
  }, [topics]);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    let counter = 0;
    const pack = (title: string, items: Item[]): Section => ({
      title,
      rows: items.map((item) => ({ item, index: counter++ })),
    });

    if (!q) {
      const out: Section[] = [];

      // Bookmarked books first, then the jump list.
      const saved: Item[] = [];
      if (ready) {
        for (const [id, entry] of Object.entries(progress)) {
          if (!entry.saved) continue;
          const match = index.get(id);
          if (match) saved.push({ kind: "book", ...match, score: 0 });
        }
      }
      if (saved.length) out.push(pack("Saved", saved.slice(0, 6)));

      // Every topic, always. This is the jump list.
      out.push(
        pack(
          "Topics",
          topics.map((topic) => ({ kind: "topic" as const, topic, score: 0 })),
        ),
      );
      return out;
    }

    const topicHits: Item[] = [];
    for (const topic of topics) {
      const score = scoreText(topic.name, q) * 1.2;
      if (score > 0) topicHits.push({ kind: "topic", topic, score });
    }
    topicHits.sort((a, b) => b.score - a.score);

    const bookHits: Item[] = [];
    for (const topic of topics) {
      for (const book of topic.books) {
        const score =
          scoreText(book.title, q) * 1.5 +
          scoreText(book.author, q) * 0.8 +
          scoreText(topic.name, q) * 0.3;
        if (score > 0) bookHits.push({ kind: "book", book, topic, score });
      }
    }
    bookHits.sort((a, b) => b.score - a.score);

    const out: Section[] = [];
    if (topicHits.length) out.push(pack("Topics", topicHits.slice(0, 8)));
    if (bookHits.length) out.push(pack("Books", bookHits.slice(0, 60)));
    return out;
  }, [query, topics, index, progress, ready]);

  /** The flat order the cursor walks, matching the render order exactly. */
  const flat = useMemo(
    () => sections.flatMap((section) => section.rows.map((row) => row.item)),
    [sections],
  );

  // Reset and focus whenever the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const id = window.setTimeout(() => input.current?.focus(), 10);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  // Keep the highlighted row in view.
  useEffect(() => {
    const node = list.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const choose = (item: Item) => {
    if (item.kind === "topic") {
      jumpTo({ kind: "topic", topicIndex: topics.indexOf(item.topic) });
    } else {
      jumpTo({ kind: "book", bookId: item.book.id });
    }
    onOpenChange(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = flat[cursor];
      if (item) choose(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-void/70 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search the library"
        className="w-full max-w-3xl overflow-hidden border border-ink/15 bg-void/95 shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          aria-label="Search"
          className="w-full bg-transparent px-5 py-4 font-serif text-2xl text-ink outline-none placeholder:text-ink/25"
        />

        <div
          ref={list}
          role="listbox"
          aria-label="Results"
          className="max-h-[56vh] overflow-y-auto border-t border-ink/10 pb-1"
        >
          {flat.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink/35">Nothing.</p>
          ) : (
            sections.map((section) => (
              // A listbox may contain groups, so the heading is announced rather
              // than being loose text between options.
              <div key={section.title} role="group" aria-label={section.title}>
                <p
                  aria-hidden="true"
                  className="meta-label sticky top-0 bg-void/95 px-5 pt-3 pb-1.5 text-ink/25"
                >
                  {section.title}
                </p>

                {section.rows.map(({ item, index: i }) => {
                  const id = item.kind === "topic" ? `topic-${item.topic.slug}` : item.book.id;
                  const state = item.kind === "book" ? progress[item.book.id] : undefined;
                  // A topic shows its hero book, so every row keeps the same column
                  // and the whole list reads as a shelf.
                  const cover =
                    item.kind === "topic"
                      ? item.topic.books[item.topic.heroIndex] ?? item.topic.books[0]
                      : item.book;

                  return (
                    <button
                      key={id}
                      type="button"
                      data-index={i}
                      role="option"
                      aria-selected={i === cursor}
                      onMouseMove={() => setCursor(i)}
                      onClick={() => choose(item)}
                      className={`flex w-full items-center gap-3.5 px-5 py-2 text-left ${
                        i === cursor ? "bg-ink/[0.07]" : ""
                      }`}
                    >
                      {/* Deliberately the 600px WebGL thumbnail rather than the
                          1000px JPEG: next/image downsizes it to the 26px it is
                          drawn at, so a screenful of results costs a few KB. */}
                      {cover ? (
                        <Image
                          src={cover.thumb}
                          alt=""
                          width={26}
                          height={39}
                          sizes="26px"
                          className="shrink-0 rounded-[2px] object-cover ring-1 ring-ink/10"
                        />
                      ) : (
                        <span className="h-[39px] w-[26px] shrink-0" aria-hidden="true" />
                      )}

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.95rem] text-ink/75">
                          {item.kind === "topic" ? (
                            item.topic.name
                          ) : (
                            <>
                              <Highlight text={item.book.title} query={query.trim()} />
                              {item.book.author && item.book.author !== "Unknown" ? (
                                <span className="text-ink/35"> · {item.book.author}</span>
                              ) : null}
                            </>
                          )}
                        </span>
                        {/* A book needs its topic for context. A topic row does not:
                            the section heading already said what it is, and
                            repeating "Topic" under every line was pure noise. */}
                        {item.kind === "book" ? (
                          <span className="meta-label mt-1 block truncate text-ink/30">
                            {item.topic.name}
                          </span>
                        ) : null}
                      </span>

                      {/* Only the states that exist. No decorative chrome. */}
                      {state?.saved ? (
                        <span className="meta-label shrink-0 text-ink/30">saved</span>
                      ) : item.kind === "topic" ? (
                        <span className="meta-label shrink-0 text-ink/25">
                          {item.topic.bookCount}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-ink/10 px-5 py-2.5">
          <p className="meta-label text-ink/25">↵ jump</p>
          <p className="meta-label text-ink/25">esc</p>
        </div>
      </div>
    </div>
  );
}
