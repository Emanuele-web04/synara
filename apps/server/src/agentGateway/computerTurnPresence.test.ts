import { describe, expect, it } from "vitest";
import { ThreadId } from "@synara/contracts";

import {
  acquireAgentGatewaySessionLease,
  agentGatewayCapabilitiesFor,
  captureAgentGatewayCapabilityInput,
  type AgentGatewaySessionLeaseOptions,
} from "./sessionLease.ts";
import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry.ts";
import { filterToolsByCapability } from "./toolRuntime.ts";

interface CatalogTool {
  readonly definition: { readonly name: string };
  readonly requiredCapability: AgentGatewayCapability;
}

const CATALOG: readonly CatalogTool[] = [
  { definition: { name: "computer_click" }, requiredCapability: "computer:control" },
  { definition: { name: "computer_get_state" }, requiredCapability: "computer:control" },
  { definition: { name: "synara_list_threads" }, requiredCapability: "thread:read" },
];

const names = (tools: readonly CatalogTool[]): string[] =>
  tools.map((tool) => tool.definition.name);

/** A credential registry stub that records what each lease minted. */
function stubCredentials() {
  const minted: Array<readonly AgentGatewayCapability[] | undefined> = [];
  let sequence = 0;
  return {
    minted,
    credentials: {
      connectionForThread: (
        _threadId: unknown,
        _provider: unknown,
        options?: AgentGatewaySessionLeaseOptions,
      ) => {
        minted.push(options?.additionalCapabilities);
        sequence += 1;
        return { url: "http://127.0.0.1:48123/mcp", bearerToken: `presence-token-${sequence}` };
      },
      revokeSessionToken: (_token: string) => undefined,
    },
  };
}

describe("computer turn presence", () => {
  it("lists computer_* when the switch is on and drops them when it is off", () => {
    const { minted, credentials } = stubCredentials();
    const threadId = ThreadId.makeUnsafe("thread-presence");

    // This turn leases with the switch on: the catalog serves the family.
    const firstInput = captureAgentGatewayCapabilityInput({ enableComputerControl: true });
    const firstLease = acquireAgentGatewaySessionLease(credentials, threadId, "codex", firstInput);
    expect(firstLease).toBeDefined();
    const firstCapabilities = new Set(agentGatewayCapabilitiesFor(firstInput));
    expect([...firstCapabilities]).toEqual(["computer:control"]);
    expect(names(filterToolsByCapability(CATALOG, firstCapabilities))).toEqual([
      "computer_click",
      "computer_get_state",
    ]);

    // The switch turns off between turns. The rotation releases the old lease
    // and mints a fresh one from the new fact — nothing throws, and the next
    // turn's catalog no longer names the family.
    firstLease?.release();
    expect(() => firstLease?.release()).not.toThrow();
    const secondInput = captureAgentGatewayCapabilityInput({ enableComputerControl: false });
    const secondCapabilities = new Set(agentGatewayCapabilitiesFor(secondInput));
    expect([...secondCapabilities]).toEqual([]);
    // The family is gone from the next turn's catalog: nothing served that
    // the fresh lease does not authorize.
    expect(names(filterToolsByCapability(CATALOG, secondCapabilities))).toEqual([]);
    const secondLease = acquireAgentGatewaySessionLease(
      credentials,
      threadId,
      "codex",
      secondInput,
    );
    expect(secondLease).toBeDefined();
    expect(secondLease?.connection.bearerToken).not.toBe(firstLease?.connection.bearerToken);
    secondLease?.release();

    // The mint itself tells the story: computer:control, then nothing.
    expect(minted).toEqual([["computer:control"], undefined]);
  });
});
