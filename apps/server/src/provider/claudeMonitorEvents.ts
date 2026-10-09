// Claude's Monitor tool wakes the agent with a `<task-notification>` user turn
// for each batch of output lines. The SDK stream never forwards that turn: only
// the reply and a result stamped `origin: task-notification` arrive, so the
// transcript would show replies with nothing that prompted them. The CLI does
// persist the notification in the session transcript, so the adapter reads the
// transcript tail for new Monitor events when such a turn starts. Best-effort:
// fs and parse failures yield no events, never an error.

import { Effect, FileSystem } from "effect";

import { findClaudeSessionTranscriptPath } from "./claudeProjectImport.ts";
import { readAppendedLines } from "./claudeWorkflowRuntime.ts";

// The notification that starts a turn sits at the transcript tail. Earlier bytes
// only matter for events already read, so a read never reaches further back.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const MAX_MONITOR_EVENT_CHARS = 2_000;

export interface ClaudeMonitorEvent {
  // Transcript entry uuid of the notification.
  readonly id: string;
  readonly createdAt: string;
  readonly taskId: string;
  readonly message: string;
}

export interface ClaudeMonitorEventCursor {
  sessionId: string | undefined;
  path: string | undefined;
  offset: number | undefined;
  readonly seenIds: Set<string>;
}

export function makeClaudeMonitorEventCursor(): ClaudeMonitorEventCursor {
  return { sessionId: undefined, path: undefined, offset: undefined, seenIds: new Set() };
}

function tagText(body: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1];
}

// Only Monitor notifications carry `<event>` lines. Other task notifications
// (finished background commands and agents) already reach Synara as SDK
// task_notification messages.
export function parseClaudeMonitorEventNotification(
  text: string,
): { readonly taskId: string; readonly message: string } | undefined {
  const body = tagText(text, "task-notification");
  const taskId = body ? tagText(body, "task-id")?.trim() : undefined;
  const event = body ? tagText(body, "event") : undefined;
  if (!body || !taskId || event === undefined) return undefined;
  // `Monitor event: "<name>"` per batch, `Monitor "<name>" stream ended` at the end.
  const name = (tagText(body, "summary") ?? "")
    .trim()
    .replace(/^Monitor event:\s*/i, "")
    .replace(/^Monitor\s+/i, "")
    .replace(/"([^"]*)"/, "$1");
  const lines = event
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const message = [name, lines.join(" · ")].filter((part) => part.length > 0).join(" — ");
  if (message.length === 0) return undefined;
  return {
    taskId,
    message:
      message.length > MAX_MONITOR_EVENT_CHARS
        ? `${message.slice(0, MAX_MONITOR_EVENT_CHARS - 1)}…`
        : message,
  };
}

function notificationText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? (block as { text?: unknown }).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function monitorEventFromLine(line: string, notBeforeMs: number) {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const origin = record.origin as { kind?: unknown } | undefined;
  if (
    record.type !== "user" ||
    record.isSidechain === true ||
    origin?.kind !== "task-notification" ||
    typeof record.uuid !== "string" ||
    typeof record.timestamp !== "string"
  ) {
    return undefined;
  }
  const createdAtMs = Date.parse(record.timestamp);
  // Notifications from before this live session belong to earlier turns.
  if (!Number.isFinite(createdAtMs) || createdAtMs < notBeforeMs) return undefined;
  const text = notificationText((record.message as { content?: unknown } | undefined)?.content);
  const parsed = text ? parseClaudeMonitorEventNotification(text) : undefined;
  if (!parsed) return undefined;
  return {
    id: record.uuid,
    createdAt: new Date(createdAtMs).toISOString(),
    taskId: parsed.taskId,
    message: parsed.message,
  } satisfies ClaudeMonitorEvent;
}

// Returns Monitor events persisted since the previous read, oldest first.
export const readClaudeMonitorEvents = (
  fileSystem: FileSystem.FileSystem,
  cursor: ClaudeMonitorEventCursor,
  input: {
    readonly sessionId: string;
    readonly configDir?: string | undefined;
    readonly notBefore: string;
  },
): Effect.Effect<ReadonlyArray<ClaudeMonitorEvent>> =>
  Effect.gen(function* () {
    if (cursor.sessionId !== input.sessionId) {
      cursor.sessionId = input.sessionId;
      cursor.path = undefined;
      cursor.offset = undefined;
    }
    cursor.path ??= yield* Effect.tryPromise(() =>
      findClaudeSessionTranscriptPath({
        sessionId: input.sessionId,
        ...(input.configDir ? { configDir: input.configDir } : {}),
      }),
    );
    if (!cursor.path) return [];
    const size = Number((yield* fileSystem.stat(cursor.path)).size);
    if (
      cursor.offset === undefined ||
      cursor.offset > size ||
      size - cursor.offset > TRANSCRIPT_TAIL_BYTES
    ) {
      // A tail start may split a line; that fragment fails to parse and is skipped.
      cursor.offset = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    }
    const appended = yield* readAppendedLines(
      fileSystem,
      cursor.path,
      cursor.offset,
      Number.POSITIVE_INFINITY,
    );
    if (!appended) return [];
    cursor.offset = appended.nextOffset;
    const notBeforeMs = Date.parse(input.notBefore);
    const events: Array<ClaudeMonitorEvent> = [];
    for (const line of appended.lines) {
      const event = monitorEventFromLine(line, Number.isFinite(notBeforeMs) ? notBeforeMs : 0);
      if (!event || cursor.seenIds.has(event.id)) continue;
      cursor.seenIds.add(event.id);
      events.push(event);
    }
    return events;
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<ClaudeMonitorEvent> => []));
