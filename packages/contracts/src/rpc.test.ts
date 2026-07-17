import { describe, expect, it } from "vitest";

import {
  WsAutomationCreateRpc,
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsProjectsDiscoverScriptsRpc,
  WsPullRequestsReviewRequestCountRpc,
  WsRpcError,
  WsRpcGroup,
} from "./rpc";
import { ORCHESTRATION_WS_METHODS } from "./orchestration";

describe("WS RPC contracts", () => {
  it("exports the additive Effect RPC group", () => {
    expect(WsRpcGroup).toBeDefined();
    expect(WsBootstrapRpcGroup.requests.has("bootstrap.negotiate")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("bootstrap.negotiate")).toBe(false);
    expect(
      WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers),
    ).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery)).toBe(
      true,
    );
  });

  it("uses a schema-backed transport error", () => {
    expect(new WsRpcError({ message: "failed" }).message).toBe("failed");
  });

  it("exports the project script discovery RPC", () => {
    expect(WsProjectsDiscoverScriptsRpc).toBeDefined();
  });

  it("exports the automation create RPC", () => {
    expect(WsAutomationCreateRpc).toBeDefined();
  });

  it("exports the count-only pull request review RPC", () => {
    expect(WsPullRequestsReviewRequestCountRpc).toBeDefined();
  });
});
