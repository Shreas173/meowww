/**
 * A tiny module-level scroll store, deliberately outside React.
 *
 * Both the DOM layer (GSAP ScrollTrigger) and the WebGL layer need the scroll
 * position every frame. Routing that through React state would re-render the
 * whole component tree 60 times a second, so instead:
 *
 *   - ScrollTrigger writes into the store in its `onUpdate`.
 *   - `useFrame` inside the canvas reads `scrollStore.get()` directly, with no
 *     subscription and no re-render.
 *   - Only the components that must re-render (the visible-window calculation)
 *     subscribe, and they do so at a much lower rate.
 */

export interface ScrollSnapshot {
  /** Horizontal offset of the track, in CSS px. */
  x: number;
  /** Total travel available (track width - viewport width), in CSS px. */
  maxX: number;
  viewportWidth: number;
  /** Pointer position normalised to -1..1 from the viewport centre, y up. */
  pointerX: number;
  pointerY: number;
  /** False on touch devices and when reduced motion is requested. */
  parallax: boolean;
  /** Index of the cover nearest the viewport centre; -1 before layout runs. */
  activeSlot: number;
  /** Index of the cover under the pointer; -1 when nothing is hovered. */
  hoveredSlot: number;
  /** Index of the topic currently occupying the viewport centre. */
  activeTopic: number;
}

const state: ScrollSnapshot = {
  x: 0,
  maxX: 0,
  viewportWidth: 0,
  pointerX: 0,
  pointerY: 0,
  parallax: true,
  activeSlot: -1,
  hoveredSlot: -1,
  activeTopic: 0,
};

type Listener = (snapshot: ScrollSnapshot) => void;

const listeners = new Set<Listener>();

export const scrollStore = {
  /** Read the live snapshot. Safe to call every frame. */
  get(): ScrollSnapshot {
    return state;
  },

  /**
   * Merge a partial update and notify subscribers. Subscribers are cheap and
   * idempotent (they bail out when nothing they care about changed), so this
   * deliberately always notifies rather than diffing every field.
   */
  set(partial: Partial<ScrollSnapshot>): void {
    Object.assign(state, partial);
    for (const listener of listeners) listener(state);
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
