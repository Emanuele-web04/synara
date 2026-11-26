// FILE: MessagesTimeline.testHost.ts
// Purpose: The host element and entries every MessagesTimeline browser test mounts.
// Layer: Browser test support

import { MessageId } from "@synara/contracts";
import type { TimelineEntry } from "../../session-logic";

const TIMELINE_HOST_STYLE =
  "display:flex;flex-direction:column;width:600px;height:520px;overflow:hidden;";

export const STARTED_AT = "2026-03-17T19:12:20.000Z";

export function createTimelineHost(style = TIMELINE_HOST_STYLE): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = style;
  document.body.append(host);
  return host;
}

/** Whether `text` is rendered somewhere the reader can see, outside a closed disclosure. */
export function isVisibleOutsideClosedDisclosure(text: string): boolean {
  const match = [...document.querySelectorAll<HTMLElement>("*")].findLast((element) =>
    (element.textContent ?? "").includes(text),
  );
  return match !== undefined && match.closest("[aria-hidden='true']") === null;
}

export function userEntry(id: string, text: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: STARTED_AT,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "user",
      text,
      createdAt: STARTED_AT,
      streaming: false,
    },
  };
}

export function assistantEntry(
  id: string,
  text: string,
  options?: { streaming?: boolean; completedAt?: string },
): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: STARTED_AT,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text,
      createdAt: STARTED_AT,
      ...(options?.completedAt ? { completedAt: options.completedAt } : {}),
      streaming: options?.streaming ?? false,
    },
  };
}

export function reasoningEntry(
  id: string,
  detail: string,
  reasoningStatus: "inProgress" | "completed",
): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: STARTED_AT,
    entry: {
      id,
      createdAt: STARTED_AT,
      activityKind: "task.progress",
      label: "Reasoning trace",
      detail,
      tone: "tool",
      toolCallId: id,
      reasoningStatus,
    },
  };
}

export function commandEntry(id: string, command: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: STARTED_AT,
    entry: {
      id,
      createdAt: STARTED_AT,
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolStatus: "completed",
      command,
    },
  };
}
