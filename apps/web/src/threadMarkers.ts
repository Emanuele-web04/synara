// FILE: threadMarkers.ts
// Purpose: Web helpers for per-thread text markers.
// Layer: Chat transcript selection actions and Environment panel.

import {
  THREAD_MARKER_LABEL_MAX_CHARS,
  type MessageId,
  type ThreadId,
  type ThreadMarker,
  type ThreadMarkerColor,
  type ThreadMarkerId,
  type ThreadMarkerStyle,
} from "@synara/contracts";
import { normalizeThreadMarkerLabel } from "@synara/shared/threadMarkers";

import { newCommandId } from "./lib/utils";
import { readNativeApi } from "./nativeApi";

const INLINE_EMPHASIS_PATTERN = /[*_`~]+/g;

export { normalizeThreadMarkerLabel };

export function deriveThreadMarkerLabel(marker: ThreadMarker): string {
  const cleaned = marker.selectedText
    .replace(INLINE_EMPHASIS_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return "Marked text";
  }
  return cleaned.length > THREAD_MARKER_LABEL_MAX_CHARS
    ? `${cleaned.slice(0, THREAD_MARKER_LABEL_MAX_CHARS - 1)}…`
    : cleaned;
}

async function dispatchMarkerCommand(
  command:
    | {
        readonly type: "thread.marker.add";
        readonly threadId: ThreadId;
        readonly markerId: ThreadMarkerId;
        readonly messageId: MessageId;
        readonly startOffset: number;
        readonly endOffset: number;
        readonly selectedText: string;
        readonly style: ThreadMarkerStyle;
        readonly color: ThreadMarkerColor;
      }
    | {
        readonly type: "thread.marker.remove";
        readonly threadId: ThreadId;
        readonly markerId: ThreadMarkerId;
      }
    | {
        readonly type: "thread.marker.done.set";
        readonly threadId: ThreadId;
        readonly markerId: ThreadMarkerId;
        readonly done: boolean;
      }
    | {
        readonly type: "thread.marker.label.set";
        readonly threadId: ThreadId;
        readonly markerId: ThreadMarkerId;
        readonly label: string | null;
      },
): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  await api.orchestration.dispatchCommand({
    commandId: newCommandId(),
    ...command,
  });
}

export function dispatchThreadMarkerAdd(input: {
  threadId: ThreadId;
  markerId: ThreadMarkerId;
  messageId: MessageId;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  style: ThreadMarkerStyle;
  color: ThreadMarkerColor;
}): Promise<void> {
  return dispatchMarkerCommand({
    type: "thread.marker.add",
    ...input,
  });
}

export function dispatchThreadMarkerRemove(
  threadId: ThreadId,
  markerId: ThreadMarkerId,
): Promise<void> {
  return dispatchMarkerCommand({ type: "thread.marker.remove", threadId, markerId });
}

export function dispatchThreadMarkerDoneSet(
  threadId: ThreadId,
  markerId: ThreadMarkerId,
  done: boolean,
): Promise<void> {
  return dispatchMarkerCommand({ type: "thread.marker.done.set", threadId, markerId, done });
}

export function dispatchThreadMarkerLabelSet(
  threadId: ThreadId,
  markerId: ThreadMarkerId,
  label: string | null,
): Promise<void> {
  return dispatchMarkerCommand({
    type: "thread.marker.label.set",
    threadId,
    markerId,
    label: normalizeThreadMarkerLabel(label),
  });
}
