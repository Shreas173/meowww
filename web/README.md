# Phase 2 — the gallery

A single-page, dark-mode editorial book gallery. Vertical scroll is remapped to
horizontal travel across 31 topic "chapter screens", with the covers rendered as a
3D wall in a fixed WebGL canvas underneath the DOM.

## Setup

```bash
cd web
npm install
npm run dev        # http://localhost:3000
```

`web/public/library.json` and `web/public/covers/` must exist first — they are the
output of Phase 1. Without them the build fails with an explanatory error rather
than a confusing one.

```bash
npm run typecheck  # tsc --noEmit
npm run build
```

`package-lock.json` is committed; `npm install` resolves with no peer-dependency
conflicts on the version matrix below.

One Next.js behaviour is worth knowing, because it costs an hour otherwise: Next 16
only trusts `localhost` for dev resources, so opening the dev server at
`http://127.0.0.1:3000` serves the page **without hydrating it** — no errors, no
Lenis, no canvas, no scrolling, just the static HTML. `next.config.ts` sets
`allowedDevOrigins` to cover both spellings.

## Deploying to Vercel

1. Import the repository and set **Root Directory** to `web`.
2. Build command `next build`, output is auto-detected. No environment variables
   are needed at runtime: library.json is imported at build time, so the page is
   fully static and served from the CDN.

Commit `web/public/` — Vercel never sees the PDFs and cannot run the pipeline.
That is ~88 MB of covers (71 MB of hero JPEGs, 18 MB of WebGL thumbnails). If you
would rather not carry that in git, move the images to object storage and point
the `cover` and `thumb` fields at absolute URLs.

## Architecture

```
app/layout.tsx        server — fonts, metadata, globals.css
  └ SmoothScroll      client — Lenis + gsap.ticker wiring
app/page.tsx          server — trims library.json and renders Gallery
  └ Gallery           client — composition root, GSAP horizontal mapping
      ├ Scene         client, ssr:false — the fixed <Canvas>
      │   └ CoverWall → CoverPlane
      ├ TopicSection  chapter screens (wordless: a name and a cover)
      ├ TopicRail     one tick per topic, doubles as a progress readout
      ├ ActiveBook    names the cover in view; the wall's only click target
      └ CommandPalette  ⌘K search over all 635 books
lib/layout.ts         pure layout maths (the shared source of truth)
lib/scrollStore.ts    module-level scroll state, outside React
lib/textureCache.ts   bounded, ref-counted GPU texture cache
lib/progress.ts       saved books, in localStorage
lib/navigation.ts     how anything asks the gallery to move
```

Three stacked layers, bottom to top: a fixed colour div that GSAP crossfades per
topic, the fixed WebGL canvas, and the scrolling DOM track.

### Why the layout is split in two

`planLibrary()` works in `vw` and is pure, so it runs identically on the server
and the client. The chapter screens are therefore plain `width: Nvw` flex items:
they server-render correctly, need no measuring pass, and hydrate without a
mismatch. Only `projectSlots()` converts to pixels, and it runs in the browser
for the WebGL layer. Both come from the same numbers, so the wall and the text
stay in lockstep.

### Scroll-driven geometry must be immediate

One rule here is worth stating because breaking it produced a subtle, ugly bug:

**Anything derived from the scroll is applied immediately; only state that changes
on its own — focus, hover — is damped.**

Covers used to damp their whole depth, `damp(z, slot.z + arc + lift)`, and then
derive the perspective compensation from that *damped* value. But `arc` is a pure
function of the scroll. So scrolling moved the target while `z` lagged a damping
time constant behind it, and the difference was read back as if it were lift. At
~2000px/s the phantom measured ~240px, pushed the compensation factor to ~1.14, and
displaced covers by up to ~170px scaled by their distance from the anchor.

The result was a shear proportional to scroll velocity that fought the direction of
travel and snapped back the moment you stopped — covers visibly jerking the wrong
way. Measured with a per-frame projection probe during a real scroll: **6 wrong-way
frames, worst jump 87px**. With `arc` applied immediately and only the lift damped:
**0 wrong-way frames**, and smaller, more even steps (156px peak vs 275px).

`arc` tracks the scroll exactly, like the group's own translation, so the wall stays
rigid while scrolling. The lift only changes when focus changes, so damping it is
still smooth — and it cannot feed back into position.

### Why the state is not in React

Scroll position, pointer position and the active cover live in a module-level
store, not React state. ScrollTrigger writes to it in `onUpdate`; `useFrame`
inside the canvas reads it directly. Routing either through React would re-render
the tree 60 times a second. The only component that re-renders on scroll is the
visible-window calculation, and it bails out when the window has not changed.

### Texture budget

The wall references 635 covers. One 600×900 mipmapped RGBA texture is ~2.9 MB, so
loading them all would take ~1.8 GB of VRAM. Instead:

- Only covers within the mount window exist as components (measured: at most 64
  desktop, 45 on a phone), each in its own Suspense boundary so one slow texture
  cannot hold up the rest.
- `lib/textureCache.ts` loads on demand, reference-counts, and disposes the
  least-recently-released textures beyond a warm budget of 48 (16 on mobile).
  Peak resident is roughly 64 mounted + 48 warm ≈ 320 MB on desktop.
- The next dozen covers are preloaded so nothing pops in.

Effective anisotropy is capped at 8 and mipmaps are generated, because wall covers
are minified well below texture size.

If you need to go lower, the single most effective knob is the pipeline's
`--thumb-width`: a 448px texture is about 45% smaller again. Regenerate with
`--force` afterwards.

## Getting around

Three ways in, all three needed once there are 635 books:

| | |
|---|---|
| **⌘K** (or `/`) | Grouped search, because the two jobs differ: **Topics** is a jump list for moving around the gallery, **Books** is for finding one title. Both are always present — with an empty query you get your **Saved** books and **all 31 topics**, so you can jump anywhere without typing; as you type, matching topics appear above matching books. Each row shows its cover, so the list scans like a shelf; a topic row shows its hero book. ↑↓ to move, **↵** to jump the gallery there. |
| **Topic rail** | One tick per topic down the right edge. The active tick expands and names itself. Click to jump. |
| **The wall itself** | Hover any cover to focus it — it lifts and grows, and the card names it. Click to centre it. The canvas takes pointer events and the DOM chapter screens are click-through, so the whole wall is live. |
| **Active cover card** | Names whatever is focused, with **Save**. If you are hovering, it follows the pointer; otherwise it shows the cover nearest the viewport centre. |

**←/→** step topic by topic, which is the natural gesture for a horizontal gallery.

### The pointer

The mouse is replaced with an iPadOS pointer (`components/Cursor.tsx`), built to
Apple's published numbers (WWDC20 "Design for the iPadOS pointer") rather than to
taste:

| Behaviour | Value | Why |
|---|---|---|
| Resting shape | **19pt circle** | Apple's documented default. An earlier version used 26px, which is 40% too heavy. |
| Tracking | **1:1, no trailing** | iPadOS deliberately has no lagging cursor; any easing on position reads as imprecision. |
| Over a control | Morphs to the control's outline + 5px, **corner radius matched** | Apple's *Highlight* effect: the pointer becomes the control's background. Apple's comfortable hit padding is ~12pt, so the visible highlight needs only a little of it. |
| While snapped | Snaps to the control's centre with **16% parallax** toward the true pointer | Apple's two-pointer model: the true position keeps tracking while the visible pointer eases onto the control. |
| Over a large object | Stays a circle, **12% larger** | Apple's *Hover* effect. It never morphs into a cover — only controls, text beams and custom shapes get that. |
| Over text | Blob hides, real caret returns | A blob is no help when you are placing an insertion point. |

Replacing someone's cursor is a real trade-off, so the guard rails matter as much
as the effect:

- **Fine pointers only** — there is nothing to replace on a touchscreen.
- **Disabled entirely under `prefers-reduced-motion`.**
- `cursor: none` is applied by the component adding a class to `<html>`, never in
  the base stylesheet, so **if it never mounts you keep your normal cursor.**
- Everything it snaps to keeps its real focus ring. The blob is decoration over the
  accessibility tree, not a substitute for it.

The cover emphasis follows the same logic. iPadOS treats a large object as a *Hover*
effect — it responds slightly. `ACTIVE_SCALE`/`ACTIVE_LIFT` in `lib/layout.ts` are
1.1 and 40px; the first version used 1.42 and 324px, which turned a glance into a
lunge and made sweeping the wall feel jumpy.

Cover hover state lives in `scrollStore` alongside the scroll position, because the
covers are three.js meshes rather than DOM nodes and the pointer needs one place to
read from. Clicks are resolved from that hover state rather than from a raycast:
R3F's own `onClick` needs the raycast at press and release to agree on an object, and
animated covers move between the two.

### Palette artwork

Result thumbnails come from the same 600px WebGL `thumb`, passed through
`next/image` at `sizes="26px"` so the optimiser serves a ~1-3 KB variant instead of
the full 30 KB file. Drawing the raw thumbnail would cost roughly 1.8 MB for a
screenful of results.

The trade-off is Vercel's image optimisation quota: each distinct cover is
transformed once per width variant and then cached, so the whole library is at most
~1,270 transformations. Well inside the Hobby plan's 5,000/month, but worth knowing
if you ever put the palette somewhere much more heavily used.

## Getting around, without any words about it

The site deliberately shows almost no text: a collection name, a topic name, a
book title and its author. Everything that used to be here — a generated quote, a
two-paragraph summary, "N volumes", a provenance line, a "Scroll" hint — is gone.
It read like a machine describing a library rather than a library. The pipeline
still generates `quote` and `summary` (they cost tokens you are currently paying
for and the site never shows them); pass `--no-api` or edit the prompt in
`pipeline.py` if you would rather stop generating them.

## Tuning the feel

| Constant in `lib/layout.ts` | Effect |
|---|---|
| `COLUMN_VW`, `ROWS` | Covers per column and column width. Together these set total scroll length: this library is 5360vw ≈ **54 viewport-widths of horizontal travel**. Raising `COLUMN_VW` lengthens the page. |
| `TEXT_SCREEN_VW` | Width of each topic's typographic opening screen (default 100vw). See the note below. |
| `COVER_FILL`, `COVER_FILL_NARROW` | How much of a column a cover occupies. Above 1.0 the covers overlap; the narrow variant does this on phones, where the fixed 10vw grid would otherwise produce 33px-wide covers. |
| `ARC_PX`, `ARC_TILT` | How far back edge covers recede and turn — the depth cue. **Keep `ARC_PX` gentle** (260, not 900): a strong curve compresses covers into the middle of the frame, recedes the outer ones far enough for the fog to erase them, and leaves the wall not reaching the edges — so those books are not there to hover. |
| `ACTIVE_SCALE`, `ACTIVE_LIFT` | How much the current cover grows and lifts. |
| `VISIBLE_BACK`/`FORWARD` | How much of the wall stays mounted. |

Because `planLibrary()` is in `vw` and shared, changing `COLUMN_VW` or `ROWS`
rethinks both the DOM section widths and the wall together — they cannot drift
apart. `COVER_FILL_NARROW` is the exception that proves the rule: it deliberately
changes only cover *size*, leaving the column grid (and so the alignment) intact.

### The rhythm is text-then-wall, and that is a deliberate choice

Each section is a full `TEXT_SCREEN_VW` of typography followed by its cover wall,
so the two never share the screen. With `TEXT_SCREEN_VW = 100`, that means **about
59% of the total scroll distance shows no covers at all** — 31 chapter screens at
100vw out of 5360vw of travel.

It reads as alternating chapters, and it is what the brief describes ("each screen
represents a different Topic", covers "transition into view"). But if you would
rather the wall were always present, the change is coordinated rather than a single
number: lower `TEXT_SCREEN_VW` *and* drop the hero cover and summary from the right
half of the chapter screen (they would sit on top of the covers), letting the wall
run through the right of the frame behind the scrim. `.editorial-scrim` already
exists for exactly that. Worth a look on a real screen before deciding.

## Performance and accessibility notes

- `PerformanceMonitor` (drei) lowers `dpr` before the frame rate degrades.
- The canvas is `aria-hidden` and `pointer-events: none`. Every title, quote and
  summary is real DOM text, so the page is readable and indexable without WebGL.
- `prefers-reduced-motion: reduce` disables Lenis smoothing and the parallax tilt.
- Touch devices skip parallax, since there is no hover to drive it.
- `positions: fixed` on the canvas works only because nothing between `<body>`
  and it applies a transform — which is why `SmoothScroll` renders a fragment and
  why the canvas is a sibling of the pinned track rather than a child of it.

## Version constraints

These are not arbitrary — R3F is a React renderer, so its major version must match
React's:

| Package | Version | Why |
|---|---|---|
| `next` | `^16.3` | App Router |
| `react` / `react-dom` | `^19.3` | R3F 9 requires React 19 (`>=19 <19.4`) |
| `@react-three/fiber` | `^9.8` | v8 does not work with React 19 or the App Router |
| `@react-three/drei` | `^10.7` | v9 peers on fiber 8 and will fail to resolve |
| `three` | `^0.186` | |
| `@types/three` | `^0.186` | **Required**: three ships no bundled types |
| `tailwindcss` | `^4.3` | v4 uses `@tailwindcss/postcss` and CSS-based `@theme`; there is no `tailwind.config.js` |
| `typescript` | `^5.9` | Pinned to the 5.x line that the rest of this stack is validated against; TypeScript 7 is current and should also work |

Next 15 works with this same fiber9/drei10/react19 rule if you prefer it.
