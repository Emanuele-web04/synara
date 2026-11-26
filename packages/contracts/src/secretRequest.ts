// FILE: secretRequest.ts
// Purpose: The wire contract for agent secret requests (`synara_request_secret`).
//          The thread records only the card's metadata and its outcome; the value
//          travels once over the authenticated socket to the server, which writes it
//          to an owner-only file and hands the agent the path.
// Layer: contracts (schema-only)

import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const SECRET_REQUEST_TOOL_NAME = "synara_request_secret";
export const SECRET_REQUESTED_ACTIVITY_KIND = "secret.requested";
export const SECRET_RESOLVED_ACTIVITY_KIND = "secret.resolved";

/** How long a delivered secret file stays on disk. */
export const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;
/** Upper bound on one secret; passwords and tokens are far smaller. */
export const SECRET_VALUE_MAX_LENGTH = 16 * 1024;

export const SecretRequestStatus = Schema.Literals(["saved", "declined", "cancelled", "timed_out"]);
export type SecretRequestStatus = typeof SecretRequestStatus.Type;

/** Payload of a `secret.requested` activity. Never carries the value. */
export type SecretRequestedActivityPayload = {
  readonly requestId: string;
  readonly label: string;
  readonly reason: string;
  readonly url?: string;
  readonly placeholder?: string;
};

/** Payload of a `secret.resolved` activity. Never carries the value. */
export type SecretResolvedActivityPayload = {
  readonly requestId: string;
  readonly status: SecretRequestStatus;
};

export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("save"),
      secret: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(SECRET_VALUE_MAX_LENGTH),
      ),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;
