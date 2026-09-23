"use client";

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import { MathUtils, type Mesh, type PlaneGeometry } from "three";
import {
  ACTIVE_LIFT,
  ACTIVE_SCALE,
  ARC_PX,
  ARC_TILT,
  HOVER_SCALE_BOOST,
  TILT_POINTER_X,
  TILT_POINTER_Y,
  type CoverSlot,
} from "@/lib/layout";
import { scrollStore } from "@/lib/scrollStore";
import { useCoverTexture } from "@/lib/textureCache";

interface CoverPlaneProps {
  slot: CoverSlot;
  /** One PlaneGeometry(1, 1) shared by every cover in the wall. */
  geometry: PlaneGeometry;
  onHover: (index: number) => void;
  onLeave: (index: number) => void;
}

/**
 * A single cover in the wall.
 *
 * Position, scale and rotation are driven imperatively in `useFrame` and are
 * never passed as props. That matters: React re-renders this component whenever
 * the visible window changes, and if position were a prop, every re-render would
 * snap the plane back to its resting place mid-animation.
 *
 * Exactly one cover is ever "focused": whatever the pointer is over, or else the
 * one nearest the viewport centre. Hovering therefore always reads as a single
 * deliberate selection rather than a second, competing highlight.
 */
export default function CoverPlane({
  slot,
  geometry,
  onHover,
  onLeave,
}: CoverPlaneProps) {
  const mesh = useRef<Mesh>(null);
  const texture = useCoverTexture(slot.book.thumb);
  /** Focus-driven only. Never derived from, or fed back into, scroll position. */
  const lift = useRef(0);
  const pointerTilt = useRef(0);

  // Runs once per slot, and again only if the wall is re-projected (resize).
  // x and y are set here and never touched again: they are scroll-independent, and
  // the group carries the scroll. Only z and the scale animate.
  useLayoutEffect(() => {
    const object = mesh.current;
    if (!object) return;
    object.position.set(slot.x, slot.y, slot.z);
    object.scale.set(slot.width, slot.height, 1);
    object.rotation.set(0, 0, 0);
  }, [slot]);

  useFrame((_, delta) => {
    const object = mesh.current;
    if (!object) return;
    const state = scrollStore.get();

    const isHovered = state.hoveredSlot === slot.index;
    // Hovering wins over proximity, so there is only ever one focused cover.
    const isFocused = isHovered || (state.hoveredSlot < 0 && state.activeSlot === slot.index);

    // Horizontal distance from the viewport centre, normalised to -1..1. Covers
    // at the edges recede and turn, so the flat wall reads as a curved shelf.
    const half = state.viewportWidth > 0 ? state.viewportWidth * 0.5 : 1;
    const offset = Math.max(-1.6, Math.min(1.6, (slot.x - state.x - half) / half));
    const arc = -ARC_PX * offset * offset;

    /*
      Scroll-driven geometry is applied IMMEDIATELY; only focus-driven geometry is
      damped. That split is the whole fix for a wall that used to shear sideways
      while you scrolled.

      This used to damp the entire depth - `damp(position.z, slot.z + arc + lift)`
      - and then derive the depth compensation from the *damped* value. But `arc`
      is a pure function of the scroll, so scrolling moves the target while z lags
      a damping time constant behind it, and the difference was read back as if it
      were lift. At ~2000px/s that phantom measured ~240px, pushed the compensation
      factor to ~1.14, and displaced covers by up to ~170px scaled by their
      distance from the anchor - a shear proportional to scroll velocity, fighting
      the direction of travel, snapping back the moment you stopped.

      `arc` tracks the scroll exactly, like the group's own translation, so the wall
      stays rigid while scrolling. The lift only changes when focus changes, so
      damping it is still smooth - and it cannot feed back into position.
    */
    const targetLift = isFocused ? ACTIVE_LIFT * (isHovered ? 1.4 : 1) : 0;
    lift.current = MathUtils.damp(lift.current, targetLift, 4.5, delta);
    object.position.z = slot.z + arc + lift.current;

    const scale = isFocused ? ACTIVE_SCALE * (isHovered ? HOVER_SCALE_BOOST : 1) : 1;
    const scaleX = MathUtils.damp(object.scale.x, slot.width * scale, 5, delta);
    // Geometry is 1x1, so the y scale is the cover height at that same scale.
    object.scale.set(scaleX, scaleX * (slot.height / slot.width), 1);

    // Turn into the arc immediately - it is scroll-driven too - and damp only the
    // part that follows the pointer.
    const wants = isFocused && state.parallax;
    pointerTilt.current = MathUtils.damp(
      pointerTilt.current,
      wants ? -state.pointerX * TILT_POINTER_Y : 0,
      4,
      delta,
    );
    object.rotation.y = offset * ARC_TILT + pointerTilt.current;
    object.rotation.x = MathUtils.damp(
      object.rotation.x,
      wants ? state.pointerY * TILT_POINTER_X : 0,
      4,
      delta,
    );
  });

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      frustumCulled
      // Hover only. Clicks are handled by the canvas wrapper, which opens
      // whatever is currently hovered - see Scene.tsx for why that is more
      // reliable than asking two separate raycasts to agree on an object.
      // stopPropagation keeps only the nearest plane from claiming the pointer,
      // which otherwise makes every cover behind it light up too.
      onPointerOver={(event) => {
        event.stopPropagation();
        onHover(slot.index);
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onLeave(slot.index);
      }}
    >
      {/* Basic material: covers are flat artwork, so lighting would only dull
          them. Fog still applies, which is what gives the wall its depth. */}
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}
