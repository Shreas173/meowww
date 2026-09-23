"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getProgress,
  hydrateProgress,
  subscribeProgress,
  type ProgressMap,
} from "./progress";

/**
 * React bindings for the local progress store.
 *
 * Hydration is the tricky part: localStorage does not exist while the server
 * renders, so the first client render must match the server's (empty) snapshot
 * and only then adopt the stored values. Both the snapshot and the derived counts
 * therefore have to be stable, module-level references - `useSyncExternalStore`
 * bails out on identity, so a fresh object per call would loop forever.
 */

const EMPTY_PROGRESS: ProgressMap = {};

function subscribe(listener: () => void): () => void {
  return subscribeProgress(listener);
}

function getServerProgress(): ProgressMap {
  return EMPTY_PROGRESS;
}

/** True once stored progress has been read on the client. */
export function useProgressReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    hydrateProgress();
    setReady(true);
  }, []);
  return ready;
}

/** The whole map. Empty until hydration, so server and first client render agree. */
export function useProgressMap(): ProgressMap {
  const ready = useProgressReady();
  const all = useSyncExternalStore(subscribe, getProgress, getServerProgress);
  return ready ? all : EMPTY_PROGRESS;
}
