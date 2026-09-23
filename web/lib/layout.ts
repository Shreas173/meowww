import type { GalleryBook, GalleryTopic } from "./types";

/**
 * Layout constants. The whole gallery is laid out from these, in two stages:
 *
 *  1. `planLibrary()` is pure and resolution-independent - it works in `vw`, so it
 *     runs identically on the server and the client. The DOM sections are then
 *     plain `width: Nvw` flex items, which means they server-render correctly
 *     with no measuring pass and no hydration mismatch.
 *  2. `projectSlots()` converts that plan into CSS pixels for the WebGL layer,
 *     which only ever runs in the browser.
 *
 * Both stages come from the same numbers, so the cover wall and the text stay in
 * lockstep as you scroll.
 */

/** Covers stacked vertically within one column of the wall. */
export const ROWS = 3;

/** Horizontal share of one column, in vw. Together with ROWS, this is the
 *  main dial on total scroll length: the whole wall is 635 covers, and every
 *  vw you add here adds roughly three screens of travel. */
export const COLUMN_VW = 10;

/** Fraction of a column a cover occupies; the remainder is gutter. */
export const COVER_FILL = 0.8;

/**
 * On phones the column grid still holds ~10 columns per screen, so a cover would
 * only be ~33px wide. Letting covers overlap reads as a dense shelf and nearly
 * doubles their apparent size, without moving the column grid - which would
 * break alignment with the DOM chapter screens.
 */
export const COVER_FILL_NARROW = 1.45;

/**
 * Columns are staggered slightly in depth so that overlapping covers (see
 * COVER_FILL_NARROW) cannot z-fight: coplanar overlapping planes have no defined
 * draw order.
 */
export const COLUMN_Z_STAGGER = 7;

/** Cover height / width. Academic covers cluster close to 2:3. */
export const COVER_ASPECT = 1.5;

/** Vertical pitch between rows, as a multiple of cover height. */
export const ROW_PITCH = 1.06;

/** The typographic "chapter opening" screen reserved at the start of each topic. */
export const TEXT_SCREEN_VW = 100;

/** How far either side of the viewport covers are kept mounted, in screens.
 *  Wider than the viewport so covers exist before they scroll into view. */
export const VISIBLE_BACK = 0.6;
export const VISIBLE_FORWARD = 1.6;

/**
 * Narrower mounting window for phones. Cover density is fixed by COLUMN_VW, so a
 * phone would otherwise mount just as many covers as a desktop - and a 600px
 * texture is wildly oversampled at phone size. Trimming the margins roughly
 * halves the resident texture budget.
 */
export const VISIBLE_BACK_NARROW = 0.25;
export const VISIBLE_FORWARD_NARROW = 1.25;

/** Below this viewport width, the narrow window is used. */
export const NARROW_VIEWPORT = 768;

/** Extra covers preloaded beyond the mounted window. */
export const PRELOAD_AHEAD = 12;

/** How strongly the active-cover search prefers the horizontal centre line. */
export const Y_WEIGHT = 0.6;

/* --- camera, shared by the canvas and the wall ---------------------------- */

/** Vertical field of view of the gallery camera, in degrees. */
export const CAMERA_FOV = 34;

/**
 * Camera distance from z = 0. Held constant: the CSS-pixel-to-world-unit mapping
 * below depends on it, and so does the fog placement.
 */
export const CAMERA_Z = 1400;

/**
 * World units per CSS pixel at z = 0.
 *
 * Derived from first principles rather than read back from the renderer, so the
 * wall and the canvas cannot disagree about scale.
 */
export function pixelsToWorld(viewportHeightPx: number): number {
  if (viewportHeightPx <= 0) return 1;
  const visibleHeight = 2 * Math.tan((CAMERA_FOV * Math.PI) / 360) * CAMERA_Z;
  return visibleHeight / viewportHeightPx;
}

/* --- depth cues, applied in the WebGL layer only -------------------------- */

/** How far back, in px-equivalent, covers at the viewport edges recede. This is
 *  what gives the flat wall depth, and what fog acts on.
 *
 *  Keep this gentle. At 900 the curve behaved like a fisheye: covers bunched into
 *  the middle of the frame, the outer ones receded far enough for the fog to erase
 *  them, and the wall stopped reaching the edges of the screen - which meant the
 *  books on either side were not even there to hover. Around 260 is a curve you
 *  read as depth rather than distortion, and the whole wall stays on screen. */
export const ARC_PX = 260;

/**
 * How much edge covers turn to follow that arc, in radians. Kept small: past
 * roughly 0.2 the outer covers read as twisted rather than as a curve.
 */
export const ARC_TILT = 0.18;

/**
 * Emphasis for the cover in focus. These are deliberately restrained.
 *
 * iPadOS treats a large object as a Hover effect - the pointer floats above it
 * and the object responds only slightly. An earlier version scaled to 1.42 and
 * lifted 324px, which turned a glance into a lunge and made sweeping the wall
 * feel jumpy.
 */
export const ACTIVE_SCALE = 1.1;

/** How far that cover lifts towards the camera, in px-equivalent. */
export const ACTIVE_LIFT = 40;

/** Extra emphasis on the cover directly under the pointer. */
export const HOVER_SCALE_BOOST = 1.05;

/**
 * Parallax tilt under the pointer, in radians. Around 0.1 is a nod; the 0.3 this
 * started at was a swivel.
 */
export const TILT_POINTER_Y = 0.1;
export const TILT_POINTER_X = 0.07;

export interface SectionPlan {
  topic: GalleryTopic;
  /** Zero-based position of this topic in the gallery. */
  index: number;
  /** Offset of the section from the start of the track, in vw. */
  leftVw: number;
  widthVw: number;
}

export interface LibraryPlan {
  sections: SectionPlan[];
  /** Total horizontal extent of the track, in vw. */
  totalVw: number;
}

export interface CoverSlot {
  /** Position in the projected array; stable across resizes, so it can be used
   *  as the "which cover is active" identity. */
  index: number;
  book: GalleryBook;
  topicIndex: number;
  /** Viewport-relative CSS pixels. */
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}

export function columnCount(bookCount: number): number {
  return Math.max(1, Math.ceil(bookCount / ROWS));
}

/** Resolution-independent plan. Pure: same input, same output, anywhere. */
export function planLibrary(input: GalleryTopic[]): LibraryPlan {
  let cursor = 0;
  const sections = input.map((topic, index) => {
    const widthVw = TEXT_SCREEN_VW + columnCount(topic.books.length) * COLUMN_VW;
    const section: SectionPlan = { topic, index, leftVw: cursor, widthVw };
    cursor += widthVw;
    return section;
  });
  return { sections, totalVw: cursor };
}

/** Total horizontal travel available to the scroll, in vw (i.e. minus the viewport). */
export function travelVw(plan: LibraryPlan): number {
  return Math.max(0, plan.totalVw - 100);
}

/** Left edge of a topic's section, in CSS pixels. Used when jumping to a topic. */
export function sectionLeftPx(
  plan: LibraryPlan,
  topicIndex: number,
  viewportWidth: number,
): number {
  const section = plan.sections[topicIndex];
  return section ? (section.leftVw * viewportWidth) / 100 : 0;
}

/** Fraction of the viewport height the three-row wall should occupy at most.
 *  On short windows the covers shrink (rather than being clipped or being pushed
 *  off their 10vw column grid). */
export const WALL_FIT = 0.82;

/**
 * Index of the section containing a track position.
 *
 * This is the authoritative "which topic are we on", independent of the cover
 * slots: a chapter screen has no covers in view at all, and the background
 * crossfade must still key off the section boundary.
 */
export function sectionAt(plan: LibraryPlan, x: number, viewportWidth: number): number {
  const { sections } = plan;
  if (sections.length === 0) return 0;
  const vw = viewportWidth > 0 ? (x * 100) / viewportWidth : 0;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (vw >= sections[i].leftVw) return i;
  }
  return 0;
}

/** Vertical extent of the wall, as a multiple of cover height. */
export function wallHeightFactor(): number {
  return (ROWS - 1) * ROW_PITCH + 1;
}

/**
 * Project the plan into CSS pixels for the WebGL layer.
 *
 * Covers sit on a fixed `COLUMN_VW` grid so they stay aligned with the DOM
 * sections, but their size is additionally capped by the available height so the
 * full ROWS-high wall fits on short viewports.
 */
export function projectSlots(
  plan: LibraryPlan,
  viewportWidth: number,
  viewportHeight = 0,
): CoverSlot[] {
  const px = (vw: number) => (vw * viewportWidth) / 100;
  const columnPx = px(COLUMN_VW);
  const fill = viewportWidth < NARROW_VIEWPORT ? COVER_FILL_NARROW : COVER_FILL;
  const byWidth = columnPx * fill;
  const byHeight =
    viewportHeight > 0
      ? (viewportHeight * WALL_FIT) / (wallHeightFactor() * COVER_ASPECT)
      : byWidth;
  const width = Math.max(24, Math.min(byWidth, byHeight));
  const height = width * COVER_ASPECT;

  const slots: CoverSlot[] = [];
  for (const section of plan.sections) {
    const wallLeft = px(section.leftVw + TEXT_SCREEN_VW);
    section.topic.books.forEach((book, bookIndex) => {
      const column = Math.floor(bookIndex / ROWS);
      const row = bookIndex % ROWS;
      slots.push({
        index: slots.length,
        book,
        topicIndex: section.index,
        x: wallLeft + column * columnPx + columnPx / 2,
        // Row 0 sits highest; three.js y points up.
        y: -(row - (ROWS - 1) / 2) * height * ROW_PITCH,
        z: -((column % 3) * COLUMN_Z_STAGGER),
        width,
        height,
      });
    });
  }
  return slots;
}

/**
 * Half-open index range of slots whose x falls inside [fromX, toX).
 *
 * `slots` is ordered by x by construction: ROWS covers share a column and so
 * share an x, which makes the array non-decreasing rather than strictly
 * increasing - still exactly what a binary search needs.
 */
function selectWindow(
  slots: CoverSlot[],
  fromX: number,
  toX: number,
): { start: number; end: number } {
  return { start: lowerBound(slots, fromX), end: lowerBound(slots, toX) };
}

/** Mount window for a given viewport, tightened on narrow screens. */
export function selectVisible(
  slots: CoverSlot[],
  x: number,
  viewportWidth: number,
  narrow: boolean,
): { start: number; end: number } {
  const back = narrow ? VISIBLE_BACK_NARROW : VISIBLE_BACK;
  const forward = narrow ? VISIBLE_FORWARD_NARROW : VISIBLE_FORWARD;
  return selectWindow(slots, x - viewportWidth * back, x + viewportWidth * forward);
}

/**
 * Index of the cover nearest a given x.
 *
 * ROWS covers share each x, so this cannot just take the closest x: it scans the
 * neighbouring columns and picks the closest match in two dimensions, with the
 * vertical term weighted down. Without the y term the "active" cover would always
 * be the topmost book of a column rather than the one at eye level.
 */
export function nearestSlot(slots: CoverSlot[], x: number): number {
  if (slots.length === 0) return -1;

  const at = lowerBound(slots, x);
  const from = Math.max(0, at - ROWS - 1);
  const to = Math.min(slots.length, at + ROWS + 1);

  let best = from;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = from; i < to; i += 1) {
    const slot = slots[i];
    const score = Math.abs(slot.x - x) + Math.abs(slot.y) * Y_WEIGHT;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return slots[best].index;
}

/** How far outside the viewport a cover may sit and still count as active. */
export const ACTIVE_MARGIN = 48;

/**
 * Index of the cover nearest the viewport centre, or -1 when no cover is on
 * screen at all. A chapter screen is 100vw of pure typography, so during one
 * there is genuinely nothing to highlight - and growing an off-screen cover would
 * read as a glitch at the edge of the frame.
 */
export function onScreenSlot(slots: CoverSlot[], x: number, viewportWidth: number): number {
  const index = nearestSlot(slots, x + viewportWidth * 0.5);
  if (index < 0) return -1;
  const slot = slots[index];
  if (slot.x < x - ACTIVE_MARGIN || slot.x > x + viewportWidth + ACTIVE_MARGIN) return -1;
  return index;
}

/** First index whose `x` is >= target. */
function lowerBound(slots: CoverSlot[], target: number): number {
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].x < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
