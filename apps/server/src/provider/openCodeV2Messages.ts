import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2";
import {
  v2Array,
  v2Number,
  v2Object,
  v2OptionalObject,
  v2OptionalString,
  v2String,
} from "./openCodeV2Json.ts";
import { normalizeOpenCodeV2Tokens } from "./openCodeV2Session.ts";
import { normalizeOpenCodeV2Content, normalizeOpenCodeV2File } from "./openCodeV2Parts.ts";

interface MessageContext {
  sessionID?: string;
  directory?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
}

function assistantError(value: unknown): AssistantMessage["error"] {
  if (value === undefined) return undefined;
  const error = v2Object(value, "message.error");
  const response = v2OptionalObject(error.response);
  const statusCode =
    error.status === undefined ? undefined : v2Number(error.status, "message.error.status");
  const responseBody = v2OptionalString(response.body);
  return {
    name: "APIError",
    data: {
      message: v2String(error.message, "message.error.message"),
      ...(statusCode === undefined ? {} : { statusCode }),
      isRetryable: statusCode !== undefined && (statusCode === 429 || statusCode >= 500),
      ...(responseBody === undefined ? {} : { responseBody }),
      metadata: { opencodeType: v2String(error.type, "message.error.type") },
    },
  };
}

export function normalizeOpenCodeV2Messages(
  value: unknown,
  context: MessageContext = {},
): Array<{ info: Message; parts: Part[] }> {
  const envelope = Array.isArray(value) ? {} : v2Object(value, "messages");
  const sessionID = v2String(envelope.sessionID ?? context.sessionID, "messages.sessionID");
  const entries = v2Array(value, "messages");
  const result: Array<{ info: Message; parts: Part[] }> = [];
  let model = context.model;
  let agent = context.agent ?? "";
  let directory = context.directory ?? "";
  let parentID = "";
  for (const entry of entries) {
    const message = v2Object(entry, "message");
    const type = v2String(message.type, "message.type");
    if (type === "model-switched") {
      const ref = v2Object(message.model, "message model");
      const variant = v2OptionalString(ref.variant);
      model = {
        id: v2String(ref.id, "model.id"),
        providerID: v2String(ref.providerID, "model.providerID"),
        ...(variant === undefined ? {} : { variant }),
      };
      continue;
    }
    if (type === "agent-switched") {
      agent = v2String(message.agent, "message.agent");
      continue;
    }
    if (type === "location-switched") {
      directory = v2String(
        v2Object(message.location, "message.location").directory,
        "message directory",
      );
      continue;
    }
    if (type !== "user" && type !== "synthetic" && type !== "assistant") continue;
    const id = v2String(message.id, "message.id");
    const identity = { messageID: id, sessionID };
    const rawTime = v2Object(message.time, "message.time");
    const created = v2Number(rawTime.created, "message.time.created");
    if (type === "user" || type === "synthetic") {
      const parts: Part[] = [
        {
          ...identity,
          id: `${id}:t0`,
          type: "text",
          text: v2String(message.text, "user.text"),
          ...(type === "synthetic" ? { synthetic: true } : {}),
        },
      ];
      for (const [index, file] of v2Array(message.files ?? [], "message.files").entries())
        parts.push(normalizeOpenCodeV2File(file, identity, index));
      result.push({
        info: {
          id,
          sessionID,
          role: "user",
          time: { created },
          agent,
          model: {
            modelID: model?.id ?? "",
            providerID: model?.providerID ?? "",
            ...(model?.variant === undefined ? {} : { variant: model.variant }),
          },
        },
        parts,
      });
      parentID = id;
      continue;
    }
    const ref = v2Object(message.model, "assistant.model");
    const variant = v2OptionalString(ref.variant);
    const finish = v2OptionalString(message.finish);
    const error = assistantError(message.error);
    const info: AssistantMessage = {
      id,
      sessionID,
      role: "assistant",
      parentID,
      modelID: v2String(ref.id, "assistant.model.id"),
      providerID: v2String(ref.providerID, "assistant.model.providerID"),
      ...(variant === undefined ? {} : { variant }),
      mode: v2String(message.agent, "assistant.agent"),
      agent: v2String(message.agent, "assistant.agent"),
      path: { cwd: directory, root: directory },
      time: {
        created,
        ...(rawTime.completed === undefined
          ? {}
          : { completed: v2Number(rawTime.completed, "message.time.completed") }),
      },
      cost: v2Number(message.cost ?? 0, "message.cost"),
      tokens: normalizeOpenCodeV2Tokens(message.tokens),
      ...(finish === undefined ? {} : { finish }),
      ...(error === undefined ? {} : { error }),
    };
    result.push({ info, parts: normalizeOpenCodeV2Content(message.content, identity) });
  }
  return result;
}
