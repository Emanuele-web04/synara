// Protocol mappings informed by Zeron (MIT, Copyright 2026 Wing).
// See opencode-v2-notice.txt for the retained license notice.
import type { OpenCodeEvent } from "./openCodeClient";

export type V2Data = Record<string, unknown>;

export function object(value: unknown): V2Data | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as V2Data)
    : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function event(type: string, properties: V2Data): OpenCodeEvent {
  // This boundary follows validation/projection of the version-specific wire data.
  return { type, properties } as OpenCodeEvent;
}

export function v2Error(error: unknown): { name: string; data: { message: string } } {
  const value = object(error);
  const name = string(value?.type) ?? string(value?._tag) ?? "UnknownError";
  return {
    name,
    data: { message: string(value?.message) ?? string(error) ?? name },
  };
}

export function v2MessageId(data: V2Data): string | undefined {
  return string(data.assistantMessageID) ?? string(data.messageID);
}

export function v2PartId(data: V2Data, kind: "text" | "reasoning"): string {
  const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
  return `${v2MessageId(data)}:${kind === "text" ? "t" : "r"}${ordinal}`;
}

export function v2TextPart(
  data: V2Data,
  kind: "text" | "reasoning",
  ended: boolean,
): OpenCodeEvent {
  const timestamp = typeof data.timestamp === "number" ? data.timestamp : 0;
  return event("message.part.updated", {
    sessionID: data.sessionID,
    part: {
      id: v2PartId(data, kind),
      sessionID: data.sessionID,
      messageID: v2MessageId(data),
      type: kind,
      text: typeof data.text === "string" ? data.text : "",
      time: { start: timestamp, ...(ended ? { end: timestamp } : {}) },
    },
  });
}

export interface V2ToolState {
  name: string;
  input: V2Data;
  start: number;
}

export function v2ToolKey(data: V2Data): string {
  return JSON.stringify([data.sessionID, v2MessageId(data), data.id ?? data.callID]);
}

export function v2ToolPart(data: V2Data, tool: V2ToolState, status: string): OpenCodeEvent {
  const id = string(data.id) ?? string(data.callID);
  const timestamp = typeof data.timestamp === "number" ? data.timestamp : tool.start;
  const content = Array.isArray(data.content) ? data.content : [];
  const output = content
    .flatMap((part) => {
      const text = object(part)?.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
  const metadata = object(data.metadata) ?? {};
  const state = {
    status,
    input: object(data.input) ?? tool.input,
    ...(status === "pending" ? { raw: typeof data.text === "string" ? data.text : "" } : {}),
    ...(status !== "pending"
      ? { time: { start: tool.start, ...(status !== "running" ? { end: timestamp } : {}) } }
      : {}),
    ...(status === "completed" ? { output, title: string(data.title) ?? tool.name, metadata } : {}),
    ...(status === "running" ? { title: string(data.title) ?? tool.name, metadata } : {}),
    ...(status === "error" ? { error: v2Error(data.error).data.message } : {}),
  };
  return event("message.part.updated", {
    sessionID: data.sessionID,
    part: {
      id: `${data.sessionID}:${v2MessageId(data)}:${id}`,
      sessionID: data.sessionID,
      messageID: v2MessageId(data),
      callID: id,
      type: "tool",
      tool: tool.name,
      state,
    },
  });
}

export function v2ShellEvent(kind: string, data: V2Data): OpenCodeEvent[] {
  const shell = object(data.shell);
  const callID = string(shell?.id);
  if (!shell || !callID || typeof shell.command !== "string") return [];
  const time = object(shell.time);
  if (kind === "session.shell.started") {
    return [
      event("session.next.shell.started", {
        sessionID: data.sessionID,
        callID,
        command: shell.command,
        timestamp: time?.started ?? data.timestamp,
      }),
    ];
  }
  if (
    shell.status === "timeout" ||
    shell.status === "killed" ||
    (typeof shell.exit === "number" && shell.exit !== 0)
  ) {
    return [
      event("session.next.tool.failed", {
        sessionID: data.sessionID,
        callID,
        timestamp: time?.completed ?? data.timestamp,
        error: {
          message: `Shell command ${shell.status === "exited" ? `exited with code ${shell.exit}` : shell.status}.`,
        },
      }),
    ];
  }
  return [
    event("session.next.shell.ended", {
      sessionID: data.sessionID,
      callID,
      output: object(data.output)?.output ?? "",
      timestamp: time?.completed ?? data.timestamp,
    }),
  ];
}
