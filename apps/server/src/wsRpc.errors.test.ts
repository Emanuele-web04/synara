import { describe, expect, it } from "vitest";
import { toWsRpcError } from "./wsRpc";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandTimeoutError,
  ProviderDeliveryRecoveryError,
} from "./orchestration/Errors";

describe("orchestration RPC rejection evidence", () => {
  it.each([
    ["stop-required", "PROVIDER_DELIVERY_STOP_REQUIRED"],
    ["stop-unconfirmed", "PROVIDER_DELIVERY_STOP_UNCONFIRMED"],
  ] as const)("preserves the %s recovery refusal for native clients", (reason, code) => {
    const error = new ProviderDeliveryRecoveryError({ reason });
    expect(toWsRpcError(error, "Recovery failed")).toMatchObject({
      code,
      message: error.message,
      retryable: false,
    });
  });
  it.each([
    new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "Task is unavailable",
    }),
    new OrchestrationCommandPreviouslyRejectedError({
      commandId: "compact",
      detail: "Task was unavailable",
    }),
  ])("reports a proven rejection for $name", (error) => {
    expect(toWsRpcError(error, "Dispatch failed")).toMatchObject({
      code: "ORCHESTRATION_COMMAND_REJECTED",
      retryable: false,
    });
  });
  it.each([
    new OrchestrationCommandTimeoutError({
      commandId: "compact",
      commandType: "thread.turn.start",
      timeoutMs: 1000,
    }),
  ])("does not turn ambiguous errors into rejection evidence: $name", (error) => {
    expect(toWsRpcError(error, "Dispatch failed").code).toBeUndefined();
  });
});
