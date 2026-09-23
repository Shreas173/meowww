/**
 * Saved books, kept in localStorage.
 *
 * Deliberately local-only: no account, no backend, nothing leaves the browser.
 */

export interface ProgressEntry {
  /** Bookmarked for later. */
  saved: boolean;
  updatedAt: number;
}

export type ProgressMap = Record<string, ProgressEntry>;

const STORAGE_KEY = "mbs.progress.v1";

let cache: ProgressMap = {};
let hydrated = false;
const listeners = new Set<() => void>();
/** Stable snapshot identity for useSyncExternalStore. */
let snapshot: ProgressMap = cache;

function read(): ProgressMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ProgressMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<ProgressEntry>;
      if (!entry.saved) continue;
      out[id] = { saved: true, updatedAt: Number(entry.updatedAt) || 0 };
    }
    return out;
  } catch {
    // Private mode / disabled storage / corrupt JSON: start empty rather than throw.
    return {};
  }
}

function commit(next: ProgressMap): void {
  cache = next;
  snapshot = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota or private mode. Keep the in-memory copy so the session still works.
    }
  }
  for (const listener of listeners) listener();
}

/** Load once, on the client. Safe to call repeatedly. */
export function hydrateProgress(): ProgressMap {
  if (!hydrated && typeof window !== "undefined") {
    cache = read();
    snapshot = cache;
    hydrated = true;
  }
  return cache;
}

export function getProgress(): ProgressMap {
  return snapshot;
}

export function subscribeProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function update(id: string, patch: Partial<ProgressEntry>): void {
  const current = cache[id];
  commit({
    ...cache,
    [id]: {
      saved: patch.saved ?? current?.saved ?? false,
      updatedAt: Date.now(),
    },
  });
}

export function toggleSaved(id: string): void {
  hydrateProgress();
  update(id, { saved: !cache[id]?.saved });
}
