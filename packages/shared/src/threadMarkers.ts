// FILE: threadMarkers.ts
// Purpose: Shared pure transforms for per-thread text markers.
// Layer: Shared runtime domain helper used by server projections and web state/actions.

import {
  THREAD_MARKER_LABEL_MAX_CHARS,
  type ThreadMarker,
  type ThreadMarkerId,
} from "@synara/contracts";

function keepExistingMarkers(markers: readonly ThreadMarker[]): ThreadMarker[] {
  return markers as ThreadMarker[];
}

function isSameMarkerRange(left: ThreadMarker, right: ThreadMarker): boolean {
  return (
    left.messageId === right.messageId &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    left.style === right.style
  );
}

type ThreadMarkerRange = Pick<ThreadMarker, "messageId" | "startOffset" | "endOffset">;

export function doThreadMarkerRangesOverlap(
  left: ThreadMarkerRange,
  right: ThreadMarkerRange,
): boolean {
  return (
    left.messageId === right.messageId &&
    left.startOffset < right.endOffset &&
    right.startOffset < left.endOffset
  );
}

export function addThreadMarker(
  markers: readonly ThreadMarker[] | null | undefined,
  marker: ThreadMarker,
): ThreadMarker[] {
  const existingMarkers = markers ?? [];
  const retainedMarkers: ThreadMarker[] = [];
  for (const entry of existingMarkers) {
    if (entry.id === marker.id || isSameMarkerRange(entry, marker)) {
      return keepExistingMarkers(existingMarkers);
    }
    if (!doThreadMarkerRangesOverlap(entry, marker)) {
      retainedMarkers.push(entry);
    }
  }
  // Keep transcript rendering deterministic: overlapping markers are replaced instead of hidden.
  return retainedMarkers.length === existingMarkers.length
    ? [...existingMarkers, marker]
    : [...retainedMarkers, marker];
}

export function removeThreadMarker(
  markers: readonly ThreadMarker[] | null | undefined,
  markerId: ThreadMarkerId,
): ThreadMarker[] {
  const existingMarkers = markers ?? [];
  const nextMarkers = existingMarkers.filter((marker) => marker.id !== markerId);
  return nextMarkers.length === existingMarkers.length
    ? keepExistingMarkers(existingMarkers)
    : nextMarkers;
}

export function normalizeThreadMarkerLabel(label: string | null): string | null {
  const trimmed = label?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > THREAD_MARKER_LABEL_MAX_CHARS
    ? trimmed.slice(0, THREAD_MARKER_LABEL_MAX_CHARS)
    : trimmed;
}

export function setThreadMarkerDone(
  markers: readonly ThreadMarker[] | null | undefined,
  markerId: ThreadMarkerId,
  done: boolean,
  updatedAt: string,
): ThreadMarker[] {
  const existingMarkers = markers ?? [];
  let changed = false;
  const nextMarkers = existingMarkers.map((marker) => {
    if (marker.id !== markerId || marker.done === done) {
      return marker;
    }
    changed = true;
    return { ...marker, done, updatedAt };
  });
  return changed ? nextMarkers : keepExistingMarkers(existingMarkers);
}

export function setThreadMarkerLabel(
  markers: readonly ThreadMarker[] | null | undefined,
  markerId: ThreadMarkerId,
  label: string | null,
  updatedAt: string,
): ThreadMarker[] {
  const normalized = normalizeThreadMarkerLabel(label);
  const existingMarkers = markers ?? [];
  let changed = false;
  const nextMarkers = existingMarkers.map((marker) => {
    if (marker.id !== markerId || (marker.label ?? null) === normalized) {
      return marker;
    }
    changed = true;
    return { ...marker, label: normalized, updatedAt };
  });
  return changed ? nextMarkers : keepExistingMarkers(existingMarkers);
}

export function isThreadMarkerAvailable(marker: ThreadMarker, messageText: string): boolean {
  if (marker.startOffset < 0 || marker.endOffset > messageText.length) {
    return false;
  }
  if (marker.endOffset <= marker.startOffset) {
    return false;
  }
  return messageText.slice(marker.startOffset, marker.endOffset) === marker.selectedText;
}
