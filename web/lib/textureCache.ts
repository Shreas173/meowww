import { useEffect } from "react";
import {
  DataTexture,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
} from "three";

/**
 * A bounded, reference-counted texture cache.
 *
 * The wall references 635 covers, but holding them all on the GPU is not an
 * option: one 600x900 mipmapped RGBA texture is roughly 2.9 MB, so the full
 * library would be ~1.8 GB of VRAM. drei's `useTexture` caches forever and never
 * disposes, so this module does the job explicitly:
 *
 *   - A texture is loaded on first use and suspended on via React Suspense.
 *   - Consumers retain it on mount and release it on unmount.
 *   - Once released, a texture becomes eligible for LRU disposal.
 *
 * Only covers near the viewport are ever mounted (see CoverWall), so the working
 * set stays at roughly MAX_IDLE_TEXTURES warm textures plus whatever is on screen.
 */

/** Idle textures kept warm, so scrolling back and forth does not re-fetch. */
const MAX_IDLE_TEXTURES =
  typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    ? 16
    : 48;

/** Anisotropy for wall covers; the driver clamps this to the device maximum. */
const ANISOTROPY = 8;

interface Entry {
  /** Null until the load settles; set to the shared fallback on failure. */
  texture: Texture | null;
  /** Set when loading failed, so callers can surface it. */
  error: unknown;
  /**
   * Always resolves. A rejected promise thrown to Suspense would be rethrown as
   * an error and tear down the tree, instead of degrading a single cover.
   */
  promise: Promise<void>;
  /** Number of mounted consumers. */
  refs: number;
  /** Infinity while in use; a logical clock value once every consumer left. */
  releasedAt: number;
}

const loader = new TextureLoader();
const entries = new Map<string, Entry>();
let clock = 0;

/** Shared 1x1 dark pixel, so a failed cover becomes a dark plate, never a crash. */
let fallback: Texture | null = null;
function fallbackTexture(): Texture {
  if (!fallback) {
    fallback = new DataTexture(new Uint8Array([18, 20, 26, 255]), 1, 1);
    fallback.colorSpace = SRGBColorSpace;
    fallback.needsUpdate = true;
  }
  return fallback;
}

function configure(texture: Texture): void {
  // Without this the covers render washed out: the images are sRGB-encoded.
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = ANISOTROPY;
  // Mipmaps matter because wall covers are minified well below texture size.
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.needsUpdate = true;
}

function idleEntries(): Array<[string, Entry]> {
  const idle: Array<[string, Entry]> = [];
  for (const pair of entries) {
    const entry = pair[1];
    if (entry.refs === 0 && entry.texture && entry.releasedAt !== Infinity) idle.push(pair);
  }
  return idle;
}

/**
 * Dispose least-recently-released idle textures until at most MAX_IDLE_TEXTURES
 * remain warm. Textures still in use are never touched.
 */
function evict(): void {
  const idle = idleEntries();
  if (idle.length <= MAX_IDLE_TEXTURES) return;
  idle.sort((a, b) => a[1].releasedAt - b[1].releasedAt);
  let excess = idle.length - MAX_IDLE_TEXTURES;
  for (const [url, entry] of idle) {
    if (excess <= 0) break;
    // The fallback is shared between every failed cover; never dispose it.
    if (entry.texture !== fallback) entry.texture?.dispose();
    entries.delete(url);
    excess -= 1;
  }
}

function createEntry(url: string): Entry {
  const entry: Entry = {
    texture: null,
    error: null,
    refs: 0,
    releasedAt: Infinity,
    promise: Promise.resolve(),
  };

  entry.promise = loader.loadAsync(url).then(
    (texture) => {
      configure(texture);
      entry.texture = texture;
    },
    (error: unknown) => {
      entry.error = error;
      entry.texture = fallbackTexture();
    },
  );

  // Owned by nobody yet, so it is releasable from the start: a component that
  // unmounts mid-load (easy to do by scrolling fast) cannot pin it forever.
  entry.releasedAt = ++clock;
  entries.set(url, entry);
  return entry;
}

/**
 * Suspense-compatible read. Throws the in-flight promise on a cold cache, which
 * is the documented way to load resources in react-three-fiber.
 */
function read(url: string): Texture {
  const existing = entries.get(url);
  if (existing) {
    if (existing.texture) return existing.texture;
    throw existing.promise;
  }
  throw createEntry(url).promise;
}

/** Load and retain a cover texture for the lifetime of the calling component. */
export function useCoverTexture(url: string): Texture {
  const texture = read(url);

  useEffect(() => {
    const entry = entries.get(url);
    if (!entry) return;
    entry.refs += 1;
    entry.releasedAt = Infinity;
    return () => {
      const current = entries.get(url);
      if (!current) return;
      current.refs = Math.max(0, current.refs - 1);
      if (current.refs === 0) {
        current.releasedAt = ++clock;
        evict();
      }
    };
  }, [url]);

  return texture;
}

/** Warm a cover before it scrolls into view. Safe to call repeatedly. */
export function preloadCover(url: string): void {
  if (typeof window === "undefined" || entries.has(url)) return;
  const entry = createEntry(url);
  // No consumer yet, so this counts as idle and is evictable immediately.
  void entry.promise.then(evict);
}

/** Diagnostics for the dev overlay; not used in the render path. */
export function textureCacheSize(): number {
  return entries.size;
}
