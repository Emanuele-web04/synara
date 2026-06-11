import type { ReviewTargetKey } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { reviewTargetKeyString } from "~/reviewStore.logic";

const EMPTY: ReadonlySet<string> = new Set();

// Viewed-file state is per-PR UI state that should survive reloads, so it persists
// to localStorage under the same canonical target identity used for comment drafts.
export function reviewViewedStorageKey(target: ReviewTargetKey | null): string | null {
  return target ? `review:viewed:${reviewTargetKeyString(target)}` : null;
}

export function toggleViewedPath(current: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(current);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

function pruneViewed(
  value: ReadonlySet<string>,
  allowedPaths: ReadonlySet<string>,
): ReadonlySet<string> {
  if (allowedPaths.size === 0) {
    return EMPTY;
  }
  const next = new Set<string>();
  for (const path of value) {
    if (allowedPaths.has(path)) {
      next.add(path);
    }
  }
  return next.size === 0 ? EMPTY : next;
}

function loadViewed(key: string | null, allowedPaths: ReadonlySet<string>): ReadonlySet<string> {
  if (!key || typeof window === "undefined") {
    return EMPTY;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return EMPTY;
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? pruneViewed(
          new Set(parsed.filter((value): value is string => typeof value === "string")),
          allowedPaths,
        )
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

function saveViewed(key: string | null, value: ReadonlySet<string>): void {
  if (!key || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    // Persisting viewed files is best-effort; ignore storage failures.
  }
}

export function useReviewViewedFiles(
  target: ReviewTargetKey | null,
  filePaths: ReadonlyArray<string> = [],
) {
  const key = reviewViewedStorageKey(target);
  const allowedPaths = useMemo(() => new Set(filePaths), [filePaths]);
  const [viewedPaths, setViewedPaths] = useState<ReadonlySet<string>>(() =>
    loadViewed(key, allowedPaths),
  );

  useEffect(() => {
    const next = loadViewed(key, allowedPaths);
    setViewedPaths(next);
    saveViewed(key, next);
  }, [allowedPaths, key]);

  const toggleViewed = useCallback(
    (path: string) => {
      if (!key || !allowedPaths.has(path)) {
        return;
      }
      setViewedPaths((current) => {
        const next = toggleViewedPath(current, path);
        saveViewed(key, next);
        return next;
      });
    },
    [allowedPaths, key],
  );

  const clearViewed = useCallback(() => {
    setViewedPaths(EMPTY);
    saveViewed(key, EMPTY);
  }, [key]);

  return { viewedPaths, toggleViewed, clearViewed };
}
