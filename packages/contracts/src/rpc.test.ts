import { describe, expect, it } from "vitest";

import {
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsComputerRpcGroup,
  WsProjectAgentRpcGroup,
} from "./rpc";
import { COMPUTER_WS_METHODS } from "./computer";
import { ORCHESTRATION_WS_METHODS } from "./orchestration";

import { WS_METHODS } from "./ws";

describe("WS RPC contracts", () => {
  it("exports every hosts namespace RPC", () => {
    // The property is "every declared hosts method has a request schema", not
    // a head count: a hardcoded number only fails later, when someone adds an
    // RPC and edits the number rather than noticing the schema is missing.
    const hostsMethods = Object.values(WS_METHODS).filter((method) => method.startsWith("hosts."));
    expect(hostsMethods.length).toBeGreaterThan(0);
    const missing = hostsMethods.filter((method) => !WsFeatureRpcGroup.requests.has(method));
    expect(missing).toEqual([]);
  });
  it("keeps bootstrap and feature RPCs in separate groups", () => {
    expect(WsBootstrapRpcGroup.requests.has("bootstrap.negotiate")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("bootstrap.negotiate")).toBe(false);
    expect(
      WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers),
    ).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery)).toBe(
      true,
    );
  });

  it("registers every computer method, including setup", () => {
    for (const method of Object.values(COMPUTER_WS_METHODS)) {
      expect(WsComputerRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("exports project-agent RPCs in a satellite group", () => {
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.linkProject")).toBe(true);
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.unlinkProject")).toBe(true);
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.getOverview")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("projectAgent.linkProject")).toBe(false);
    expect(WsFeatureRpcGroup.requests.has("projectAgent.getOverview")).toBe(false);
  });
});
