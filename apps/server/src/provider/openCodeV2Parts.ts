import type { FilePart, Part, ToolState } from "@opencode-ai/sdk/v2";
import {
  v2Array,
  v2Number,
  v2Object,
  v2OptionalObject,
  v2OptionalString,
  v2String,
} from "./openCodeV2Json.ts";

interface PartIdentity {
  sessionID: string;
  messageID: string;
}

export function normalizeOpenCodeV2File(
  value: unknown,
  identity: PartIdentity,
  ordinal: number,
): FilePart {
  const file = v2Object(value, "file");
  const source = v2OptionalObject(file.source);
  const mime = v2String(file.mime, "file.mime");
  const filename = v2OptionalString(file.name);
  return {
    ...identity,
    id: `${identity.messageID}:f${ordinal}`,
    type: "file",
    mime,
    ...(filename === undefined ? {} : { filename }),
    url:
      typeof file.uri === "string"
        ? file.uri
        : source.type === "uri"
          ? v2String(source.uri, "file.source.uri")
          : `data:${mime};base64,${v2String(file.data, "file.data")}`,
  };
}

function toolState(value: Record<string, unknown>, identity: PartIdentity): ToolState {
  const state = v2Object(value.state, "tool.state");
  const time = v2Object(value.time, "tool.time");
  const start = v2Number(time.ran ?? time.created, "tool.time.start");
  if (state.status === "streaming")
    return { status: "pending", input: {}, raw: v2String(state.input, "tool input") };
  const input = v2Object(state.input, "tool input");
  const metadata = v2OptionalObject(state.metadata);
  if (state.status === "running") return { status: "running", input, metadata, time: { start } };
  const end = v2Number(time.completed, "tool.time.completed");
  if (state.status === "error") {
    const error = v2Object(state.error, "tool error");
    return {
      status: "error",
      input,
      metadata: { ...metadata, opencodeError: error },
      error: v2String(error.message, "tool error.message"),
      time: { start, end },
    };
  }
  if (state.status !== "completed") throw new Error("Invalid OpenCode v2 tool.state.status");
  const output: string[] = [];
  const attachments: FilePart[] = [];
  for (const [index, entry] of v2Array(state.content, "tool.content").entries()) {
    const content = v2Object(entry, "tool content");
    if (content.type === "text") output.push(v2String(content.text, "tool content.text"));
    else if (content.type === "file")
      attachments.push(normalizeOpenCodeV2File(content, identity, index));
    else throw new Error("Unsupported OpenCode v2 tool content type");
  }
  return {
    status: "completed",
    input,
    metadata,
    title: v2OptionalString(metadata.title) ?? v2String(value.name, "tool.name"),
    output: output.join("\n"),
    attachments,
    time: { start, end },
  };
}

export function normalizeOpenCodeV2Content(value: unknown, identity: PartIdentity): Part[] {
  const counts = { text: 0, reasoning: 0 };
  return v2Array(value, "message.content").map((entry): Part => {
    const part = v2Object(entry, "message content");
    if (part.type === "text") {
      return {
        ...identity,
        id: `${identity.messageID}:t${counts.text++}`,
        type: "text",
        text: v2String(part.text, "message text"),
      };
    }
    if (part.type === "reasoning") {
      const time = v2OptionalObject(part.time);
      return {
        ...identity,
        id: `${identity.messageID}:r${counts.reasoning++}`,
        type: "reasoning",
        text: v2String(part.text, "message reasoning"),
        time: {
          start: v2Number(time.created ?? 0, "reasoning.time.created"),
          ...(time.completed === undefined
            ? {}
            : { end: v2Number(time.completed, "reasoning.time.completed") }),
        },
      };
    }
    if (part.type === "tool") {
      const callID = v2String(part.id, "tool.id");
      return {
        ...identity,
        id: `${identity.sessionID}:${identity.messageID}:${callID}`,
        type: "tool",
        callID,
        tool: v2String(part.name, "tool.name"),
        state: toolState(part, identity),
      };
    }
    throw new Error(`Unsupported OpenCode v2 message content type ${part.type}`);
  });
}
