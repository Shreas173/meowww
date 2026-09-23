"use client";

import { useEffect, useState } from "react";
import { jumpTo } from "@/lib/navigation";
import { scrollStore } from "@/lib/scrollStore";
import type { GalleryTopic } from "@/lib/types";

interface TopicRailProps {
  topics: GalleryTopic[];
}

/**
 * The only persistent navigation: one tick per topic down the right edge.
 *
 * It answers the two questions a 54-screen horizontal scroll raises - where am I,
 * and what else is there - without adding a menu. The active tick expands and
 * names itself; the rest are quiet.
 */
export default function TopicRail({ topics }: TopicRailProps) {
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);

  // Read the position straight from the scroll store rather than through React
  // state, and only re-render when the topic actually changes.
  useEffect(() => {
    const read = () => {
      const next = scrollStore.get().activeTopic;
      setActive((current) => (current === next ? current : next));
    };
    read();
    return scrollStore.subscribe(read);
  }, []);

  return (
    <nav
      aria-label="Topics"
      className="fixed top-1/2 right-0 z-30 hidden -translate-y-1/2 flex-col items-end gap-[3px] pr-3 md:flex"
    >
      {topics.map((topic, index) => {
        const isActive = index === active;
        const showLabel = isActive || hovered === index;

        return (
          <button
            key={topic.slug}
            type="button"
            onClick={() => jumpTo({ kind: "topic", topicIndex: index })}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered((h) => (h === index ? null : h))}
            aria-current={isActive ? "true" : undefined}
            aria-label={topic.name}
            className="group flex items-center justify-end gap-2 py-[2px]"
          >
            <span
              className={`meta-label truncate text-right transition-all duration-300 ${
                showLabel
                  ? "max-w-[16rem] text-ink/70 opacity-100"
                  : "max-w-0 text-ink/0 opacity-0"
              }`}
            >
              {topic.name}
            </span>

            {/* The tick itself. */}
            <span
              className={`block h-px transition-all duration-300 ${
                isActive ? "w-9 bg-ink/25" : "w-4 bg-ink/20 group-hover:w-6 group-hover:bg-ink/35"
              }`}
            />
          </button>
        );
      })}
    </nav>
  );
}
