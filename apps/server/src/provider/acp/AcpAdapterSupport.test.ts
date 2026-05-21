import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  acpPermissionOutcome,
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  selectAcpFullAccessPermissionOptionId,
  selectAcpPermissionOptionId,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("selects the provider's real permission option id for approval decisions", () => {
    const options = [
      { kind: "reject_once", optionId: "deny-now" },
      { kind: "allow_once", optionId: "allow-this-tool" },
      { kind: "allow_always", optionId: "allow-session" },
    ] as const;

    expect(selectAcpPermissionOptionId("accept", options)).toBe("allow-this-tool");
    expect(selectAcpPermissionOptionId("acceptForSession", options)).toBe("allow-session");
    expect(selectAcpPermissionOptionId("decline", options)).toBe("deny-now");
    expect(selectAcpPermissionOptionId("cancel", options)).toBeUndefined();
  });

  it("selects the session-wide approval option for full-access ACP sessions", () => {
    expect(
      selectAcpFullAccessPermissionOptionId([
        { kind: "allow_once", optionId: "allow-once" },
        { kind: "allow_always", optionId: "allow-session" },
      ]),
    ).toBe("allow-session");
    expect(
      selectAcpFullAccessPermissionOptionId([{ kind: "allow_once", optionId: "allow-once" }]),
    ).toBe("allow-once");
  });

  it("reads failed ACP tool details without treating successful tools as failures", () => {
    expect(
      readAcpFailedToolDetail({
        status: "failed",
        detail: " Failed to request permission ",
        title: "Shell",
      }),
    ).toBe("Failed to request permission");
    expect(readAcpFailedToolDetail({ status: "failed", title: "Shell failed" })).toBe(
      "Shell failed",
    );
    expect(readAcpFailedToolDetail({ status: "failed" })).toBe("Tool call failed.");
    expect(readAcpFailedToolDetail({ status: "completed", detail: "ignored" })).toBeUndefined();
  });

  it("classifies provider-cancelled turns with failed tools as failed", () => {
    expect(
      classifyAcpPromptTurnCompletion({
        stopReason: "cancelled",
        failedToolDetail: "Failed to request permission from user",
      }),
    ).toEqual({
      state: "failed",
      errorMessage: "Failed to request permission from user",
    });
    expect(classifyAcpPromptTurnCompletion({ stopReason: "cancelled" })).toEqual({
      state: "cancelled",
    });
    expect(
      classifyAcpPromptTurnCompletion({
        stopReason: "end_turn",
        failedToolDetail: "Recovered tool failure",
      }),
    ).toEqual({ state: "completed" });
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      "cursor",
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
