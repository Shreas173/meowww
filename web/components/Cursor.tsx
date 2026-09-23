"use client";

import { useEffect, useRef, useState } from "react";
import { scrollStore } from "@/lib/scrollStore";

/**
 * The iPadOS pointer, rebuilt from Apple's published specification rather than
 * from taste. The numbers below are the ones that matter:
 *
 *  - The default pointer is a **19-point circle** (WWDC20 "Design for the iPadOS
 *    pointer"). It does not grow over arbitrary content.
 *  - It morphs in exactly three cases: into the shape of a **control** (the
 *    Highlight effect, where it becomes the control's background), into a
 *    **vertical beam** over text, or into a custom shape. Over a large object it
 *    keeps its default shape and floats above it - the **Hover** effect, whose
 *    scale is intentionally slight.
 *  - It tracks the pointer **1:1**. iPadOS deliberately has no trailing cursor,
 *    so any easing on position reads as sloppy rather than smooth.
 *  - On a control it uses a **two-pointer model**: the true position keeps
 *    tracking freely while the *visible* pointer snaps toward the control's
 *    centre, with a small parallax revealing where the true pointer is.
 *
 * Everything else here is the guard rails that make replacing someone's cursor
 * defensible: fine pointers only, off under `prefers-reduced-motion`, the caret
 * restored over text fields, and `cursor: none` applied by this component rather
 * than in the stylesheet - so if it never mounts, you keep your normal cursor.
 */

/** Apple's documented default pointer diameter, in points. */
const POINTER_SIZE = 19;
/** How far the highlight extends past the control it stands in for. Apple's
 *  comfortable hit padding is ~12pt around a bezelled control, so the visible
 *  highlight only needs a little of that. */
const MORPH_PADDING = 5;
/** How much of the true pointer position shows through while snapped. */
const PARALLAX = 0.16;
/** Per-frame approach to the target. Effectively 1:1 (about three frames), while
 *  still easing the moment it breaks off a control. */
const FOLLOW = 0.45;
/** Size and radius settle slightly slower than position. That difference is what
 *  reads as a morph rather than a jump. */
const MORPH = 0.3;
/** The Hover effect for large objects: present, but nowhere near a balloon. */
const HOVER_SCALE = 1.12;

type Mode = "default" | "snap" | "text" | "hover";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

const INTERACTIVE =
  'a[href], button, [role="button"], summary, label, [data-cursor="link"]';
const TEXT = 'input, textarea, [contenteditable="true"]';

function rectOf(element: HTMLElement): Rect {
  const box = element.getBoundingClientRect();
  // Match the control's own corner radius, which is what makes the highlight read
  // as the button's background rather than a sticker on top of it.
  const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
  return { left: box.left, top: box.top, width: box.width, height: box.height, radius };
}

export default function Cursor() {
  const blob = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduced) return;

    setEnabled(true);
    document.documentElement.classList.add("cursor-hidden");

    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const target = { mode: "default" as Mode, rect: null as Rect | null };
    const current = {
      x: pointer.x,
      y: pointer.y,
      w: POINTER_SIZE,
      h: POINTER_SIZE,
      r: POINTER_SIZE / 2,
    };
    let visible = true;

    const sample = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      const element = event.target as HTMLElement | null;
      if (element?.closest(TEXT)) {
        // A beam belongs over text, not a blob. The real caret is restored in CSS.
        target.mode = "text";
        target.rect = null;
        return;
      }

      const control = element?.closest<HTMLElement>(INTERACTIVE);
      if (control) {
        target.mode = "snap";
        target.rect = rectOf(control);
        return;
      }

      target.rect = null;
      // Covers are three.js meshes, not DOM nodes, so this comes from the canvas.
      target.mode = scrollStore.get().hoveredSlot >= 0 ? "hover" : "default";
    };

    /** A book hover can begin or end without the pointer moving - for example
     *  when the wall scrolls underneath a stationary mouse. */
    const syncHover = () => {
      if (target.mode === "snap" || target.mode === "text") return;
      target.mode = scrollStore.get().hoveredSlot >= 0 ? "hover" : "default";
    };

    const hide = () => {
      visible = false;
    };
    const show = () => {
      visible = true;
    };

    const render = () => {
      frame = requestAnimationFrame(render);
      const node = blob.current;
      if (!node) return;

      /*
        Position. When standing in for a control the visible pointer eases onto
        its centre, offset slightly toward the true pointer so the parallax shows
        where you actually are. Otherwise it tracks the pointer exactly - iPadOS
        has no trailing cursor, and any lag here reads as imprecision.
      */
      let wantX = pointer.x;
      let wantY = pointer.y;
      if (target.mode === "snap" && target.rect) {
        const cx = target.rect.left + target.rect.width / 2;
        const cy = target.rect.top + target.rect.height / 2;
        wantX = cx + (pointer.x - cx) * PARALLAX;
        wantY = cy + (pointer.y - cy) * PARALLAX;
      }
      current.x += (wantX - current.x) * FOLLOW;
      current.y += (wantY - current.y) * FOLLOW;

      let wantW = POINTER_SIZE;
      let wantH = POINTER_SIZE;
      let wantR = POINTER_SIZE / 2;

      if (target.mode === "snap" && target.rect) {
        wantW = target.rect.width + MORPH_PADDING * 2;
        wantH = target.rect.height + MORPH_PADDING * 2;
        wantR = Math.min(wantH / 2, target.rect.radius + MORPH_PADDING);
      } else if (target.mode === "hover") {
        // The Hover effect: same shape, a touch larger, a touch more shadow.
        wantW = wantH = POINTER_SIZE * HOVER_SCALE;
        wantR = wantW / 2;
      }

      current.w += (wantW - current.w) * MORPH;
      current.h += (wantH - current.h) * MORPH;
      current.r += (wantR - current.r) * MORPH;

      const shown = visible && target.mode !== "text";
      node.style.transform = `translate3d(${current.x}px, ${current.y}px, 0) translate(-50%, -50%)`;
      node.style.width = `${current.w}px`;
      node.style.height = `${current.h}px`;
      node.style.borderRadius = `${current.r}px`;
      node.style.opacity = shown ? "1" : "0";
      node.style.boxShadow =
        target.mode === "snap" || target.mode === "hover"
          ? "inset 0 0 0 0.5px rgba(255,255,255,0.55), 0 0 0 0.5px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.22)"
          : "inset 0 0 0 0.5px rgba(255,255,255,0.5), 0 0 0 0.5px rgba(0,0,0,0.06), 0 1px 5px rgba(0,0,0,0.18)";
    };

    let frame = requestAnimationFrame(render);
    window.addEventListener("pointermove", sample, { passive: true });
    window.addEventListener("pointerdown", sample, { passive: true });
    document.addEventListener("pointerleave", hide);
    document.addEventListener("pointerenter", show);
    const unsubscribe = scrollStore.subscribe(syncHover);

    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      window.removeEventListener("pointermove", sample);
      window.removeEventListener("pointerdown", sample);
      document.removeEventListener("pointerleave", hide);
      document.removeEventListener("pointerenter", show);
      document.documentElement.classList.remove("cursor-hidden");
    };
  }, []);

  if (!enabled) return null;

  return (
    <div
      ref={blob}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-[100] opacity-0"
      style={{
        width: POINTER_SIZE,
        height: POINTER_SIZE,
        borderRadius: POINTER_SIZE / 2,
        background: "rgba(255,255,255,0.32)",
        // A slight blur plus a hairline edge is what makes it readable over both
        // a dark wall and a white book cover, the way the system pointer adapts.
        backdropFilter: "blur(1.5px)",
        WebkitBackdropFilter: "blur(1.5px)",
        boxShadow:
          "inset 0 0 0 0.5px rgba(255,255,255,0.5), 0 0 0 0.5px rgba(0,0,0,0.06), 0 1px 5px rgba(0,0,0,0.18)",
        transition: "opacity 140ms ease",
        willChange: "transform, width, height",
      }}
    />
  );
}
