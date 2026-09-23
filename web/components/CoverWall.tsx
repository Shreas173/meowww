"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Color, Fog, Group, PlaneGeometry } from "three";
import {
  ARC_PX,
  CAMERA_Z,
  NARROW_VIEWPORT,
  PRELOAD_AHEAD,
  pixelsToWorld,
  selectVisible,
  type CoverSlot,
} from "@/lib/layout";
import { scrollStore } from "@/lib/scrollStore";
import { preloadCover } from "@/lib/textureCache";
import CoverPlane from "./CoverPlane";

/**
 * Fog is placed relative to the arc rather than at fixed world distances: the
 * arc depth is expressed in CSS pixels and therefore scales with the viewport, so
 * deriving the fog from it keeps the wall fading the same way at any size. The
 * un-arced centre of the wall is never fogged, and the arced edges fade by about
 * half into the page colour.
 */
const FOG_START = 0.35;
const FOG_END = 1.7;

interface CoverWallProps {
  slots: CoverSlot[];
  /** Dark hex per topic, indexed by topic; drives the fog crossfade. */
  topicColors: string[];
}

/**
 * The wall of covers.
 *
 * Two things keep this affordable with 635 books:
 *
 *  - `pxToWorld` maps CSS pixels onto three.js units so the wall can be laid out
 *    in the same pixel space as the DOM, then handed to a single scaled group.
 *  - Only slots within the visible window are mounted, in their own Suspense
 *    boundaries so one slow texture cannot hold up the rest.
 */
export default function CoverWall({ slots, topicColors }: CoverWallProps) {
  const group = useRef<Group>(null);

  // CSS pixels -> world units, derived from the camera rather than read back from
  // the renderer, so the wall and the canvas cannot disagree about scale.
  const size = useThree((state) => state.size);
  const pxToWorld = pixelsToWorld(size.height);

  const geometry = useMemo(() => new PlaneGeometry(1, 1), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const initialColor = topicColors[0] ?? "#07070a";
  const fog = useMemo(() => new Fog(new Color(initialColor), 1, 2), [initialColor]);
  const targetColor = useMemo(() => new Color(initialColor), [initialColor]);

  // The arc depth in world units; fog brackets it so the wall's edges dissolve
  // into the page colour without washing out the centre.
  const arcWorld = ARC_PX * pxToWorld;
  useEffect(() => {
    fog.near = CAMERA_Z + arcWorld * FOG_START;
    fog.far = CAMERA_Z + arcWorld * FOG_END;
  }, [fog, arcWorld]);

  const [visible, setVisible] = useState({ start: 0, end: 0 });

  useEffect(() => {
    if (slots.length === 0) return;

    const recompute = () => {
      const { x, viewportWidth } = scrollStore.get();
      if (!viewportWidth) return;
      const next = selectVisible(slots, x, viewportWidth, viewportWidth < NARROW_VIEWPORT);
      // Return the previous object when the window is unchanged so React bails
      // out entirely; this runs on every scroll frame.
      setVisible((previous) =>
        previous.start === next.start && previous.end === next.end ? previous : next,
      );
    };

    recompute();
    return scrollStore.subscribe(recompute);
  }, [slots]);

  useEffect(() => {
    if (slots.length === 0) return;
    const stop = Math.min(slots.length, visible.end + PRELOAD_AHEAD);
    for (let index = visible.end; index < stop; index += 1) {
      preloadCover(slots[index].book.thumb);
    }
  }, [slots, visible.end]);

  useFrame((_, delta) => {
    const state = scrollStore.get();

    const active = topicColors[state.activeTopic];
    if (active) targetColor.set(active);
    // Frame-synced crossfade. The DOM background layer is tweened by GSAP over
    // the same duration, so the two land on the same colour together.
    fog.color.lerp(targetColor, Math.min(1, delta * 3));

    /*
      The wall's translation, in two parts, both of which are easy to get wrong.

      The group is scaled by `pxToWorld`, so its CHILDREN are in CSS pixels - but
      the group's own position is in world units, so the offset has to be converted
      too. And the camera sits on the world origin looking down -z, so the track
      position that lands on the screen centre is `scroll + viewportWidth / 2`, not
      `scroll`. Dropping either term slides the whole wall sideways: the first
      version shrank it to ~79% and put the right of the screen out of covers
      entirely, so most books could not be hovered.
    */
    if (group.current) {
      group.current.position.x = -((state.x + state.viewportWidth / 2) * pxToWorld);
    }
  });

  const setHovered = useCallback((index: number) => {
    if (scrollStore.get().hoveredSlot !== index) scrollStore.set({ hoveredSlot: index });
  }, []);

  const clearHovered = useCallback((index: number) => {
    // Only clear if this plane is still the hovered one. Moving between two
    // overlapping covers fires the new pointerover before the old pointerout, and
    // an unconditional clear would drop the hover you just moved to.
    if (scrollStore.get().hoveredSlot === index) scrollStore.set({ hoveredSlot: -1 });
  }, []);

  return (
    <>
      <primitive object={fog} attach="fog" />
      {/* One scale for the whole wall: all slot coordinates stay in CSS pixels. */}
      <group ref={group} scale={pxToWorld}>
        {slots.slice(visible.start, visible.end).map((slot) => (
          <Suspense key={slot.book.id} fallback={null}>
            <CoverPlane
              slot={slot}
              geometry={geometry}
              onHover={setHovered}
              onLeave={clearHovered}
            />
          </Suspense>
        ))}
      </group>
    </>
  );
}
