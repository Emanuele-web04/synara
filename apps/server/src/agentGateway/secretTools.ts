// FILE: secretTools.ts
// Purpose: The `synara_request_secret` gateway tool. The agent asks for a password,
//          token, or key; the user answers in a private card in the thread; the value
//          goes to an owner-only file and the agent receives only that file's path.
// Layer: Agent Gateway tool (provider-neutral; every provider with the thread-scoped gateway)
// Exports: makeAgentGatewaySecretTools

import {
  SECRET_REQUEST_TOOL_NAME,
  SECRET_REQUESTED_ACTIVITY_KIND,
  SECRET_RESOLVED_ACTIVITY_KIND,
  type SecretRequestedActivityPayload,
  type SecretResolvedActivityPayload,
} from "@synara/contracts";
import { Effect } from "effect";

import type { SecretRequestGate } from "../secrets/SecretRequestGate.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readNumberArg, readStringArg } from "./toolInput.ts";
import type { ToolEntry } from "./toolRuntime.ts";

export const SECRET_REQUEST_DEFAULT_TIMEOUT_MS = 10 * 60_000;
const SECRET_REQUEST_MIN_TIMEOUT_MS = 10_000;
const SECRET_REQUEST_MAX_TIMEOUT_MS = 60 * 60_000;
const LABEL_MAX_LENGTH = 120;
const TEXT_MAX_LENGTH = 1_000;

const DESCRIPTION = [
  "Ask the user for a password, token, or other secret in a private card in this chat, instead of asking them to paste it into the conversation. Use it whenever a command needs a secret, such as a sudo password when passwordless sudo is unavailable.",
  "The call waits until the user answers. On save it returns `file`: an owner-only file holding exactly the value, with no trailing newline. Read it only inside the command that needs it and never print, echo, or copy it.",
  "Examples: `sudo -S -p '' <command> < <file>`; `TOKEN=\"$(cat <file>)\" <command>`.",
  "The file is deleted after 24 hours. A declined request means the user chose not to share it: do not ask again in chat or another way; say what is blocked. After cancelled or timed_out, ask again only if the secret is still needed.",
].join(" ");

const STATUS_NOTES = {
  declined:
    "The user declined. Don't ask for it in chat or another way; say what's blocked and go on without it.",
  cancelled: "The request closed before an answer. Ask again only if the secret is still needed.",
  timed_out: "No answer in time. Don't ask in chat; ask again only if it is still needed.",
} as const;

function readBoundedText(
  args: Record<string, unknown>,
  name: string,
  maxLength: number,
  required: boolean,
): string | undefined {
  const raw = readStringArg(args, name, { required });
  if (raw === undefined) return undefined;
  // Control characters would render as junk in the card.
  const value = raw.replace(/\p{Cc}+/gu, " ").trim();
  if (value.length === 0) {
    throw new ToolInputError(`Argument "${name}" must contain visible text.`);
  }
  if (value.length > maxLength) {
    throw new ToolInputError(`Argument "${name}" must be at most ${maxLength} characters.`);
  }
  return value;
}

function readUrl(args: Record<string, unknown>): string | undefined {
  const raw = readStringArg(args, "url");
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.host !== "") {
      return url.toString();
    }
  } catch {
    // Fall through to the error.
  }
  throw new ToolInputError('Argument "url" must be an http(s) URL.');
}

function readSecretRequestArgs(args: Record<string, unknown>) {
  const label = readBoundedText(args, "label", LABEL_MAX_LENGTH, true)!;
  const reason = readBoundedText(args, "reason", TEXT_MAX_LENGTH, true)!;
  const placeholder = readBoundedText(args, "placeholder", LABEL_MAX_LENGTH, false);
  const url = readUrl(args);
  const delivery = readStringArg(args, "delivery");
  if (delivery !== undefined && delivery !== "file") {
    throw new ToolInputError('Argument "delivery" must be "file".');
  }
  const requestedTimeout = readNumberArg(args, "timeoutMs");
  const timeoutMs = Math.min(
    SECRET_REQUEST_MAX_TIMEOUT_MS,
    Math.max(
      SECRET_REQUEST_MIN_TIMEOUT_MS,
      Math.round(requestedTimeout ?? SECRET_REQUEST_DEFAULT_TIMEOUT_MS),
    ),
  );
  return { label, reason, placeholder, url, timeoutMs };
}

export interface AgentGatewaySecretToolsInput {
  readonly gate: Pick<SecretRequestGate, "request">;
  /** Owner-only directory that receives delivered secret files. */
  readonly filesDir: string;
  readonly appendActivity: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly requestId: string;
    readonly kind: typeof SECRET_REQUESTED_ACTIVITY_KIND | typeof SECRET_RESOLVED_ACTIVITY_KIND;
    readonly summary: string;
    readonly payload: SecretRequestedActivityPayload | SecretResolvedActivityPayload;
  }) => Effect.Effect<void, unknown>;
}

export function makeAgentGatewaySecretTools(
  input: AgentGatewaySecretToolsInput,
): ReadonlyArray<ToolEntry> {
  const requestSecret: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: SECRET_REQUEST_TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            minLength: 1,
            maxLength: LABEL_MAX_LENGTH,
            description: "Card title, such as 'sudo password' or 'GitHub token'.",
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: TEXT_MAX_LENGTH,
            description: "One or two sentences: what it is for and where to get it.",
          },
          url: {
            type: "string",
            description: "Optional http(s) page where the user can get the value.",
          },
          placeholder: {
            type: "string",
            maxLength: LABEL_MAX_LENGTH,
            description: "Optional input placeholder.",
          },
          delivery: {
            type: "string",
            enum: ["file"],
            description: "Always file: the value is written to an owner-only file.",
          },
          timeoutMs: {
            type: "integer",
            minimum: SECRET_REQUEST_MIN_TIMEOUT_MS,
            maximum: SECRET_REQUEST_MAX_TIMEOUT_MS,
            description: `How long to wait for an answer. Defaults to ${SECRET_REQUEST_DEFAULT_TIMEOUT_MS / 60_000} minutes.`,
          },
        },
        required: ["label", "reason"],
        additionalProperties: false,
      },
      annotations: {
        title: "Request a secret from the user",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      // Claude defers MCP tools behind ToolSearch; agents that never load this one ask in chat.
      _meta: { "anthropic/alwaysLoad": true },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const { label, reason, placeholder, url, timeoutMs } = yield* Effect.try({
          try: () => readSecretRequestArgs(args),
          catch: (cause) => cause,
        });
        const turnId = context.callerTurnId;
        if (turnId === null) {
          return yield* Effect.fail(
            new ToolInputError("Secrets can only be requested during an active turn."),
          );
        }
        const threadId = context.callerThreadId;
        const outcome = yield* Effect.tryPromise({
          try: (signal) =>
            input.gate.request({
              threadId,
              filesDir: input.filesDir,
              timeoutMs,
              signal,
              publish: (requestId) =>
                Effect.runPromise(
                  input.appendActivity({
                    threadId,
                    turnId,
                    requestId,
                    kind: SECRET_REQUESTED_ACTIVITY_KIND,
                    summary: `Asking for a secret: ${label}`,
                    payload: {
                      requestId,
                      label,
                      reason,
                      ...(url === undefined ? {} : { url }),
                      ...(placeholder === undefined ? {} : { placeholder }),
                    },
                  }),
                ),
              onSettled: (requestId, status) =>
                Effect.runPromise(
                  input.appendActivity({
                    threadId,
                    turnId,
                    requestId,
                    kind: SECRET_RESOLVED_ACTIVITY_KIND,
                    summary: `Secret request ${status.replace("_", " ")}`,
                    payload: { requestId, status },
                  }),
                ),
            }),
          catch: (cause) => new ToolInputError(errorText(cause)),
        });
        if (outcome.status === "saved") {
          return mcpToolResultJson({ status: "saved", file: outcome.file });
        }
        return mcpToolResultJson({ status: outcome.status, note: STATUS_NOTES[outcome.status] });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [requestSecret];
}
