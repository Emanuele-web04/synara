import * as Crypto from "node:crypto";

import { OrchestrationCommand, type OrchestrationCommand as Command } from "@synara/contracts";
import { Schema } from "effect";

export const ORCHESTRATION_COMMAND_FINGERPRINT_VERSION = 1;

export interface OrchestrationCommandFingerprint {
  readonly version: number;
  readonly value: string;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalizeJson(record[key])]),
    );
  }
  return value;
}

function commandIntent(command: Command): Record<string, unknown> {
  const decoded = Schema.decodeUnknownSync(OrchestrationCommand)(command);
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

export function fingerprintOrchestrationCommand(
  command: Command,
): OrchestrationCommandFingerprint {
  const canonical = JSON.stringify(
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
