import type * as Acp from "@agentclientprotocol/sdk";
import * as Schema from "effect/Schema";

const AcpErrorCode = Schema.Number;

export class AcpSpawnError extends Schema.TaggedErrorClass<AcpSpawnError>()("AcpSpawnError", {
  command: Schema.optional(Schema.String),
  cause: Schema.Defect,
}) {
  override get message() {
    return this.command
      ? `Failed to spawn ACP process for command: ${this.command}`
      : "Failed to spawn ACP process";
  }
}

export class AcpTransportError extends Schema.TaggedErrorClass<AcpTransportError>()(
  "AcpTransportError",
  {
    detail: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class AcpRequestError extends Schema.TaggedErrorClass<AcpRequestError>()("AcpRequestError", {
  code: AcpErrorCode,
  errorMessage: Schema.String,
  data: Schema.optional(Schema.Unknown),
}) {
  override get message() {
    return this.errorMessage;
  }

  static parseError(message = "Parse error", data?: unknown) {
    return new AcpRequestError({
      code: -32700,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }
}

export const AcpError = Schema.Union([AcpRequestError, AcpSpawnError, AcpTransportError]);

export type AcpError = typeof AcpError.Type;

type AssignableTo<Target, Source extends Target> = Source;

export type AcpErrorCodeCompatibility = AssignableTo<Acp.ErrorCode, typeof AcpErrorCode.Type>;
