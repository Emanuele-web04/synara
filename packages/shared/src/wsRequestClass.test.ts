import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyWsRequest,
  makeWsRequestCapacityError,
  WS_REQUEST_CLASS_LIMITS,
} from "./wsRequestClass";

describe("wsRequestClass", () => {
  it("keeps the per-connection budgets the server and client both enforce", () => {
    expect(WS_REQUEST_CLASS_LIMITS).toEqual({ control: 16, standard: 12, "expensive-read": 2 });
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe("control");
    expect(classifyWsRequest(WS_METHODS.providerStopIdleRuntimeSession)).toBe("control");
    expect(classifyWsRequest(ORCHESTRATION_WS_METHODS.replayEvents)).toBe("expensive-read");
    expect(classifyWsRequest(WS_METHODS.gitListBranches)).toBe("standard");
  });

  it("builds the retryable capacity rejection clients depend on", () => {
    expect(makeWsRequestCapacityError("expensive-read")).toMatchObject({
      code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 250,
    });
    for (const requestClass of ["standard", "control"] as const) {
      expect(makeWsRequestCapacityError(requestClass)).toMatchObject({
        code: "RPC_REQUEST_CAPACITY_EXCEEDED",
        retryable: true,
        retryAfterMs: 250,
        message: `WebSocket ${requestClass} request capacity exceeded.`,
      });
    }
  });
});
