/**
 * Programmatic navigation.
 *
 * The gallery lives in two coordinate spaces (the DOM track in `vw`, the wall in
 * pixels) and either Chrome or the canvas can ask to move it. Rather than have
 * every component know about Lenis and the layout, the pieces register here:
 *
 *   - SmoothScroll registers its Lenis instance so we can scroll smoothly.
 *   - Gallery registers a jumper that knows how to convert "this topic" or
 *     "this book" into a scroll position.
 *
 * Everything degrades to native scrolling when Lenis is not running (which is the
 * case under `prefers-reduced-motion`).
 */

interface ScrollController {
  scrollTo(target: number, options?: Record<string, unknown>): void;
}

export type JumpTarget =
  | { kind: "topic"; topicIndex: number }
  | { kind: "book"; bookId: string };

let controller: ScrollController | null = null;
let jumper: ((target: JumpTarget) => void) | null = null;

export function registerLenis(instance: ScrollController | null): void {
  controller = instance;
}

export function registerJumper(next: ((target: JumpTarget) => void) | null): void {
  jumper = next;
}

/** Smoothly scroll to a vertical offset, which the gallery maps to horizontal. */
export function scrollToOffset(y: number, immediate = false): void {
  const clamped = Math.max(0, y);
  if (controller) {
    controller.scrollTo(clamped, {
      duration: immediate ? 0 : 1.1,
      immediate,
      // A gentle ease-out; Lenis' default feels sluggish over long distances.
      easing: (t: number) => 1 - Math.pow(1 - t, 3),
    });
    return;
  }
  if (typeof window === "undefined") return;
  window.scrollTo({ top: clamped, behavior: immediate ? "instant" : "smooth" });
}

export function jumpTo(target: JumpTarget): void {
  jumper?.(target);
}
