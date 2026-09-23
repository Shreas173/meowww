"use client";

import { useEffect, useState } from "react";
import type { CoverSlot } from "@/lib/layout";
import { scrollStore } from "@/lib/scrollStore";
import { toggleSaved } from "@/lib/progress";
import { useProgressMap } from "@/lib/useProgress";
import type { GalleryTopic } from "@/lib/types";

interface ActiveBookProps {
  slots: CoverSlot[];
  topics: GalleryTopic[];
}

/**
 * Names the cover the viewport is parked on.
 *
 * It follows the same "active cover" the canvas highlights, so the thing that
 * grows on screen is the thing named here, and it tracks the pointer while
 * hovering. Renders nothing during a chapter screen, when no cover is in view.
 */
export default function ActiveBook({ slots, topics }: ActiveBookProps) {
  const [index, setIndex] = useState(-1);
  const progress = useProgressMap();

  useEffect(() => {
    const read = () => {
      const state = scrollStore.get();
      // Hovering wins: the card names whatever the pointer is on, falling back to
      // the cover the viewport is parked on.
      const next = state.hoveredSlot >= 0 ? state.hoveredSlot : state.activeSlot;
      setIndex((current) => (current === next ? current : next));
    };
    read();
    return scrollStore.subscribe(read);
  }, []);

  const slot = index >= 0 ? slots[index] : undefined;
  const topic = slot ? topics[slot.topicIndex] : undefined;
  if (!slot || !topic) return null;

  const entry = progress[slot.book.id];
  const saved = Boolean(entry?.saved);

  return (
    <div className="pointer-events-none fixed bottom-0 left-0 z-30 hidden max-w-[42vw] px-[6vw] pb-[6vh] md:block">
      <div className="pointer-events-auto">
        <p className="truncate text-[0.95rem] text-ink/85">{slot.book.title}</p>
        <p className="meta-label mt-1.5 truncate text-ink/35">
          {slot.book.author && slot.book.author !== "Unknown" ? slot.book.author : topic.name}
        </p>

        <button
          type="button"
          onClick={() => toggleSaved(slot.book.id)}
          aria-pressed={saved}
          className="meta-label mt-3 border border-ink/25 px-3.5 py-2 text-ink/60 transition-colors hover:border-ink/60 hover:text-ink aria-pressed:border-ink/50 aria-pressed:text-ink"
        >
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}
