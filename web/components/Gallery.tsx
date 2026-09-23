"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  onScreenSlot,
  planLibrary,
  projectSlots,
  sectionAt,
  sectionLeftPx,
  travelVw,
  type CoverSlot,
} from "@/lib/layout";
import { jumpTo, registerJumper, scrollToOffset } from "@/lib/navigation";
import { scrollStore } from "@/lib/scrollStore";
import type { GalleryPayload } from "@/lib/types";
import ActiveBook from "./ActiveBook";
import CommandPalette from "./CommandPalette";
import TopicRail from "./TopicRail";
import Cursor from "./Cursor";
import TopicSection from "./TopicSection";

/** The canvas touches `window` and WebGL, so it must never render on the server. */
const Scene = dynamic(() => import("./Scene"), { ssr: false });

interface GalleryProps {
  payload: GalleryPayload;
}

/**
 * Composition root for the gallery.
 *
 * Three stacked layers: a fixed colour div that GSAP crossfades per topic, the
 * fixed WebGL wall, and the scrolling DOM chapter screens. A single ScrollTrigger
 * over a pinned viewport converts vertical scroll into horizontal travel and
 * feeds the same progress to the wall through the scroll store, so the two stay
 * in lockstep without re-rendering React per frame.
 *
 * On top of that sit the three ways in: ⌘K search, the topic rail, and the active
 * cover card - which is what makes the wall clickable despite the canvas being
 * pointer-transparent.
 */
export default function Gallery({ payload }: GalleryProps) {
  const { topics } = payload;

  const plan = useMemo(() => planLibrary(topics), [topics]);
  const topicColors = useMemo(() => topics.map((topic) => topic.color), [topics]);
  const pinRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const backgroundRef = useRef<HTMLDivElement | null>(null);

  const [slots, setSlots] = useState<CoverSlot[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // --- pointer parallax --------------------------------------------------- //
  useEffect(() => {
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const parallax = !coarsePointer && !reducedMotion;

    scrollStore.set({ parallax, viewportWidth: window.innerWidth });
    if (!parallax) return;

    const onPointerMove = (event: PointerEvent) => {
      scrollStore.set({
        pointerX: (event.clientX / window.innerWidth) * 2 - 1,
        // Flip y so the value reads as "up" in the three.js coordinate system.
        pointerY: -((event.clientY / window.innerHeight) * 2 - 1),
      });
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);

  // --- vertical scroll -> horizontal travel + colour crossfade ------------ //
  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;

    void (async () => {
      const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
      ]);
      if (disposed) return;
      gsap.registerPlugin(ScrollTrigger);

      const pin = pinRef.current;
      const track = trackRef.current;
      if (!pin || !track) return;

      let projected: CoverSlot[] = [];
      let travel = 0;
      let backgroundTween: gsap.core.Tween | null = null;
      let activeTopic = 0;

      /**
       * Re-project the wall for the current viewport. The plan is in vw, so this
       * is the only place pixels are computed. Runs on mount and on resize.
       */
      const measure = () => {
        const width = window.innerWidth;
        const height = window.innerHeight;
        projected = projectSlots(plan, width, height);
        setSlots(projected);
        travel = Math.max(0, (travelVw(plan) * width) / 100);
        scrollStore.set({ viewportWidth: width, maxX: travel });
      };

      const crossfadeTo = (topicIndex: number) => {
        const color = plan.sections[topicIndex]?.topic.color;
        const layer = backgroundRef.current;
        if (!color || !layer) return;
        backgroundTween?.kill();
        backgroundTween = gsap.to(layer, {
          backgroundColor: color,
          duration: 1.1,
          ease: "power2.inOut",
          overwrite: true,
        });
      };

      measure();

      // Everything that wants to move the gallery goes through here.
      registerJumper((target) => {
        if (target.kind === "topic") {
          scrollToOffset(sectionLeftPx(plan, target.topicIndex, window.innerWidth));
          return;
        }
        const slot = projected.find((candidate) => candidate.book.id === target.bookId);
        if (!slot) return;
        // Centre the cover rather than putting it at the left edge.
        scrollToOffset(slot.x - window.innerWidth / 2);
      });

      const trigger = ScrollTrigger.create({
        trigger: pin,
        start: "top top",
        // `end` is re-evaluated on refresh, so it must read the latest travel.
        end: () => `+=${Math.max(1, travel)}`,
        pin: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          const x = self.progress * travel;
          gsap.set(track, { x: -x });

          const width = window.innerWidth;
          // The topic is decided by section geometry, not by the nearest cover:
          // during a chapter screen no cover is on screen at all.
          const topicIndex = sectionAt(plan, x + width * 0.5, width);
          scrollStore.set({
            x,
            activeTopic: topicIndex,
            activeSlot: onScreenSlot(projected, x, width),
          });

          if (topicIndex !== activeTopic) {
            activeTopic = topicIndex;
            crossfadeTo(topicIndex);
          }
        },
      });

      // Start on the first topic's colour rather than tweening into it, and prime
      // the store so a cover is already active before the first scroll event.
      const firstColor = plan.sections[0]?.topic.color ?? "#07070a";
      if (backgroundRef.current) gsap.set(backgroundRef.current, { backgroundColor: firstColor });
      scrollStore.set({
        x: 0,
        activeSlot: onScreenSlot(projected, 0, window.innerWidth),
        activeTopic: sectionAt(plan, window.innerWidth * 0.5, window.innerWidth),
      });
      ScrollTrigger.refresh();

      const remeasure = () => {
        measure();
        ScrollTrigger.refresh();
      };
      window.addEventListener("resize", remeasure);
      // Section widths are in vw so fonts cannot reflow the track, but the
      // chapter screens are text-height sensitive, so refresh once fonts land.
      void document.fonts?.ready.then(() => ScrollTrigger.refresh()).catch(() => undefined);

      teardown = () => {
        registerJumper(null);
        window.removeEventListener("resize", remeasure);
        backgroundTween?.kill();
        trigger.kill();
      };
    })();

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [plan]);

  // --- keyboard ----------------------------------------------------------- //
  useEffect(() => {
    const currentTopic = () => scrollStore.get().activeTopic;

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a text field.
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === "ArrowRight") {
        // Step topics: the natural gesture for a horizontal gallery.
        jumpTo({ kind: "topic", topicIndex: Math.min(topics.length - 1, currentTopic() + 1) });
      } else if (event.key === "ArrowLeft") {
        jumpTo({ kind: "topic", topicIndex: Math.max(0, currentTopic() - 1) });
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [topics.length]);

  return (
    <>
      {/* 1. Background colour layer. GSAP tweens this; the WebGL fog is lerped
             towards the same colour so the wall dissolves into the page. */}
      <div
        ref={backgroundRef}
        aria-hidden="true"
        className="fixed inset-0 z-0"
        style={{ backgroundColor: topics[0]?.color ?? "#07070a" }}
      />

      {/* 2. Fixed WebGL wall. Decorative only: aria-hidden, no pointer events. */}
      <Scene slots={slots} topicColors={topicColors} />

      {/*
        3. The chrome. Three words of it, all of it functional: the collection,
        the way to search it, and the topic you are in.
      */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-between px-[6vw] py-[5vh]">
        <p className="meta-label text-ink/45">Mathematics</p>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="meta-label pointer-events-auto text-ink/30 transition-colors hover:text-ink/70"
        >
          ⌘K
        </button>
      </div>

      <TopicRail topics={topics} />

      <ActiveBook slots={slots} topics={topics} />

      {/* The iPad-style pointer. Renders nothing on touch or reduced motion. */}
      <Cursor />

      <CommandPalette
        topics={topics}
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
      />

      {/*
        4. The scrolling DOM layer.

        `overflow-hidden` is required: the track is far wider than the viewport, and
        without it the page would scroll sideways. ScrollTrigger pins this element
        for `travel` pixels.

        The wrapper is not decoration. ScrollTrigger reparents the pinned element
        into a `.pin-spacer`, and if that element were a direct child of the
        fragment, React's sibling bookkeeping would break the moment anything
        mounted next to it ("insertBefore ... is not a child of this node"). Owning
        the element in a stable wrapper keeps GSAP's DOM surgery inside a subtree
        React never reshuffles.
      */}
      {/*
        `pointer-events-none` lives on this wrapper, not on the pinned element,
        and that distinction is the whole fix. ScrollTrigger wraps the pinned
        element in its own `.pin-spacer` div, which inherits a z-index above the
        canvas and would swallow every pointer event - so putting the rule on the
        inner element only disables a node that is no longer the one receiving
        them. Pointer events are inherited, so disabling them here covers whatever
        ScrollTrigger injects.
      */}
      <div className="pointer-events-none">
        <div ref={pinRef} className="relative z-20 h-screen w-full overflow-hidden">
          <div
            ref={trackRef}
            className="flex h-screen will-change-transform"
            style={{ width: `${plan.totalVw}vw` }}
          >
            {plan.sections.map((section) => (
              <TopicSection key={section.topic.slug} section={section} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
