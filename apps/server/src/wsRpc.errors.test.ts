import { describe, expect, it } from "vitest";
import { toWsRpcError } from "./wsRpc";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandTimeoutError,
  OrchestrationCommandInternalError,
} from "./orchestration/Errors";

describe("orchestration RPC rejection evidence", () => {
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
    new OrchestrationCommandInternalError({
      commandId: "compact",
      commandType: "thread.turn.start",
      detail: "Worker exited",
    }),
    new Error("Lost connection"),
  ])("does not turn ambiguous errors into rejection evidence: $name", (error) => {
    expect(toWsRpcError(error, "Dispatch failed").code).toBeUndefined();
  });
});
