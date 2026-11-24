import * as Crypto from "node:crypto";

import { OrchestrationCommand, type OrchestrationCommand as Command } from "@synara/contracts";
import { Schema } from "effect";

export const ORCHESTRATION_COMMAND_FINGERPRINT_VERSION = 1;

export interface OrchestrationCommandFingerprint {
  readonly version: number;
  readonly value: string;
}

const decodeOrchestrationCommand = Schema.decodeUnknownSync(OrchestrationCommand);

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    const length = value.length;
    const out = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      out[index] = canonicalizeJson(value[index]);
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      const entry = record[key];
      if (entry !== undefined) {
        out[key] = canonicalizeJson(entry);
      }
    }
    return out;
  }
  return value;
}

function commandIntent(command: Command): Record<string, unknown> {
  const decoded = decodeOrchestrationCommand(command);
  const { commandId: _commandId, ...intent } = decoded;
  if (intent.type !== "thread.turn.start") {
    return intent;
  }

  return {
    ...intent,
    message: {
      ...intent.message,
      attachments: intent.message.attachments.map((attachment) => {
        switch (attachment.type) {
          case "assistant-selection":
            return {
              type: attachment.type,
              assistantMessageId: attachment.assistantMessageId,
              text: attachment.text,
            };
          case "image":
          case "file":
            // Name, MIME, and size are resolved from the managed server ledger. Only the
            // attachment identity belongs to the idempotent client command intent.
            return { type: attachment.type, id: attachment.id };
        }
      }),
    },
  };
}

function tryBuildFastAssistantDeltaCanonicalJson(command: Command): string | null {
  if (command.type !== "thread.message.assistant.delta" || command.attachments !== undefined) {
    return null;
  }
  const { createdAt, delta, messageId, segmentSequence, segmentStartedAt, threadId, turnId } =
    command;
  if (
    typeof createdAt !== "string" ||
    typeof delta !== "string" ||
    typeof messageId !== "string" ||
    typeof threadId !== "string" ||
    (segmentSequence !== undefined &&
      (typeof segmentSequence !== "number" ||
        !Number.isInteger(segmentSequence) ||
        segmentSequence < 0)) ||
    (segmentStartedAt !== undefined && typeof segmentStartedAt !== "string") ||
    (turnId !== undefined && typeof turnId !== "string")
  ) {
    return null;
  }
  // Exact same sorted-key JSON as `canonicalizeJson({ version, command: intent })`.
  let json = `{"command":{"createdAt":${JSON.stringify(createdAt)},"delta":${JSON.stringify(delta)},"messageId":${JSON.stringify(messageId)}`;
  if (segmentSequence !== undefined) {
    json += `,"segmentSequence":${segmentSequence}`;
  }
  if (segmentStartedAt !== undefined) {
    json += `,"segmentStartedAt":${JSON.stringify(segmentStartedAt)}`;
  }
  json += `,"threadId":${JSON.stringify(threadId)}`;
  if (turnId !== undefined) {
    json += `,"turnId":${JSON.stringify(turnId)}`;
  }
  json += `,"type":"thread.message.assistant.delta"},"version":${ORCHESTRATION_COMMAND_FINGERPRINT_VERSION}}`;
  return json;
}

export function fingerprintOrchestrationCommand(command: Command): OrchestrationCommandFingerprint {
  const canonical =
    tryBuildFastAssistantDeltaCanonicalJson(command) ??
    JSON.stringify(
      canonicalizeJson({
        version: ORCHESTRATION_COMMAND_FINGERPRINT_VERSION,
        command: commandIntent(command),
      }),
    );
  return {
    version: ORCHESTRATION_COMMAND_FINGERPRINT_VERSION,
    value: Crypto.createHash("sha256").update(canonical).digest("hex"),
  };
}
