import { ORCHESTRATION_WS_METHODS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { isRpcMethodBlockedByPendingCheckpointFileRestore } from "./wsRpc.ts";

describe("wsRpc checkpoint file restore gate", () => {
  it("gates importThread while a destructive file restore is pending", () => {
    expect(
      isRpcMethodBlockedByPendingCheckpointFileRestore(ORCHESTRATION_WS_METHODS.importThread),
    ).toBe(true);
  });

  it("does not gate read-only snapshot RPCs", () => {
    expect(
      isRpcMethodBlockedByPendingCheckpointFileRestore(ORCHESTRATION_WS_METHODS.getSnapshot),
    ).toBe(false);
  });
});
