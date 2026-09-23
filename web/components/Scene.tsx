"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useCallback, useRef, useState } from "react";
import { CAMERA_FOV, CAMERA_Z, type CoverSlot } from "@/lib/layout";
import { jumpTo } from "@/lib/navigation";
import { scrollStore } from "@/lib/scrollStore";
import CoverWall from "./CoverWall";

interface SceneProps {
  slots: CoverSlot[];
  topicColors: string[];
}

/**
 * The fixed WebGL layer.
 *
 * Unlike the rest of the canvas chrome this layer *does* take pointer events -
 * that is what makes individual covers hoverable and clickable. The DOM track
 * above it is set to `pointer-events: none` so that hovers fall through to the
 * wall, while the rail, the active-cover card and the overlays keep their own.
 *
 * The canvas stays `aria-hidden`: three.js meshes are not focusable DOM controls,
 * so there is no keyboard path inside it regardless. The accessible equivalents
 * are the ⌘K palette and the card's Save button, both real, focusable elements.
 *
 * `ssr: false` (see Gallery) keeps the whole thing off the server. The canvas is
 * transparent rather than clearing to the topic colour, so the crossfading DOM
 * background layer stays the single source of truth for the page's colour and the
 * fog simply tints the wall into it.
 */
export default function Scene({ slots, topicColors }: SceneProps) {
  const [dpr, setDpr] = useState(1.5);

  const clearHover = useCallback(() => {
    if (scrollStore.get().hoveredSlot !== -1) scrollStore.set({ hoveredSlot: -1 });
  }, []);

  /*
    Clicks are resolved from the hover state rather than from a raycast.

    R3F's own onClick needs the raycast at pointerdown and at click to land on the
    same object. Covers are animated - they lift and grow when focused - so which
    plane is nearest shifts mid-gesture and the two raycasts disagree. Hover is
    already accurate and settled by the time you click, so acting on the hovered
    cover is both simpler and reliable.

    Clicking centres the book on the wall. It doubles as a way to bring a cover you
    are looking at into the middle of the frame.
  */
  const pressAt = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    pressAt.current = { x: event.clientX, y: event.clientY };
  }, []);

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      const start = pressAt.current;
      pressAt.current = null;
      // A drag (or a scroll gesture) must not open whatever it happened to end on.
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const hovered = scrollStore.get().hoveredSlot;
      const slot = hovered >= 0 ? slots[hovered] : undefined;
      if (slot) jumpTo({ kind: "book", bookId: slot.book.id });
    },
    [slots],
  );

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-10"
      aria-hidden="true"
      // Leaving the canvas must drop the hover, or a cover stays enlarged after
      // the pointer has moved onto the chrome.
      onPointerLeave={clearHover}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      <Canvas
        dpr={dpr}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        camera={{ fov: CAMERA_FOV, position: [0, 0, CAMERA_Z], near: 1, far: 9000 }}
        onCreated={({ gl }) => gl.setClearAlpha(0)}
        // three.js defaults the canvas to `touch-action: none`, which would stop
        // touch users scrolling the gallery at all. The page's only scroll axis
        // is vertical, so allow native pan-y and keep pointer events for taps.
        style={{ touchAction: "pan-y" }}
      >
        {/* Scale resolution down before frame rate suffers on weaker GPUs. */}
        <PerformanceMonitor
          onChange={({ factor }) => setDpr(factor > 0.8 ? 1.75 : factor > 0.55 ? 1.35 : 1)}
        />
        <CoverWall slots={slots} topicColors={topicColors} />
      </Canvas>
    </div>
  );
}
