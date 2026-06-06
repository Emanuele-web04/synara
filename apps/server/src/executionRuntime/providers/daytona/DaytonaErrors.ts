import { Schema } from "effect";

/**
 * DaytonaApiError - A Daytona REST call failed (network, non-2xx, or a malformed
 * body). Detail is redacted of credential material by the caller before it
 * reaches a log or surfaces past the adapter boundary.
 */
export class DaytonaApiError extends Schema.TaggedErrorClass<DaytonaApiError>()("DaytonaApiError", {
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  detail: Schema.String,
}) {
  override get message(): string {
    const status = this.status === null ? "no-response" : String(this.status);
    return `Daytona ${this.operation} failed (${status}): ${this.detail}`;
  }
}

/**
 * DaytonaSandboxUnknownError - An operation referenced a sandbox id the client
 * has no record of (never created, or already destroyed).
 */
export class DaytonaSandboxUnknownError extends Schema.TaggedErrorClass<DaytonaSandboxUnknownError>()(
  "DaytonaSandboxUnknownError",
  {
    sandboxId: Schema.String,
  },
) {
  override get message(): string {
    return `No Daytona sandbox: ${this.sandboxId}`;
  }
}
