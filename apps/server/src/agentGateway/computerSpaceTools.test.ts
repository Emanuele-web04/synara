import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerSpaceInventory, ProviderKind } from "@synara/contracts";

import { ComputerManager } from "../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import { makeAgentGatewayComputerTools } from "./computerTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext } from "./toolRuntime.ts";

const inventory: ComputerSpaceInventory = {
  source: "macos-managed-spaces",
  complete: true,
  spaces: [{ id: 2, uuid: "uuid-2", displayId: "display-a", kind: "desktop", current: false }],
};
const managers: ComputerManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
});
function context(provider: ProviderKind = "claudeAgent"): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "session",
      threadId: "a",
      provider,
      turnId: "turn",
    },
    callerThreadId: "a",
    callerThreadLabel: "Fixture",
    callerSessionKey: "session",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}
function json(result: McpToolCallResult): Record<string, unknown> {
  const text = result.content.find((c) => c.type === "text");
  return text?.type === "text" ? JSON.parse(text.text) : {};
}
function setup(designate = vi.fn(async (): Promise<readonly number[]> => [2])) {
  const backend = Object.assign(new FakeComputerBackend(), {
    listSpaces: vi.fn(async () => inventory),
  });
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  managers.push(manager);
  const authorizeAction = vi.fn(async () => true);
  const entries = makeAgentGatewayComputerTools({
    manager,
    resolveSpaceDesignation: designate,
    authorizeAction,
  });
  const call = (name: string, args: Record<string, unknown>, provider?: ProviderKind) =>
    Effect.runPromise(
      entries.find((e) => e.definition.name === name)!.handler(args, context(provider)),
    );
  const inspect = (args: Record<string, unknown>, provider?: ProviderKind) =>
    call("computer_inspect", { tool: "computer_spaces", arguments: args }, provider);
  return { manager, backend, entries, call, inspect, designate, authorizeAction };
}

describe("discoverable computer_spaces gateway", () => {
  it("has a real inspect/help route and adds no advertised tool", async () => {
    const { entries, call, inspect } = setup();
    expect(entries.find((e) => e.definition.name === "computer_spaces")?.discoveryOnly).toBe(true);
    const help = await call("computer_help", { tool: "computer_spaces" });
    expect(JSON.stringify(json(help))).toContain("computer_inspect");
    const result = await inspect({ operation: "list" });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ inventory, reservation: null, changedDesktop: false });
  });

  it("reserves only after fresh user designation, without repeated desktop approval", async () => {
    const { inspect, designate, authorizeAction } = setup();
    const result = await inspect({ operation: "reserve", space_id: 2 });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ reservation: { spaceId: 2 }, changedDesktop: false });
    expect(JSON.stringify(json(result))).not.toContain('"threadId"');
    expect(JSON.stringify(json(result))).not.toContain('"turnId"');
    expect(designate).toHaveBeenCalledTimes(2);
    expect(authorizeAction).not.toHaveBeenCalled();
  });

  it("full access cannot invent user designation and late revocation prevents commit", async () => {
    const { inspect, manager, designate } = setup(
      vi.fn(async (): Promise<readonly number[]> => []),
    );
    const denied = await inspect({ operation: "reserve", space_id: 2 });
    expect(json(denied)).toMatchObject({ error: { code: "computer_space_not_designated" } });
    designate.mockResolvedValueOnce([2]).mockResolvedValueOnce([]);
    const revoked = await inspect({ operation: "reserve", space_id: 2 });
    expect(json(revoked)).toMatchObject({ error: { code: "computer_space_not_designated" } });
    expect(manager.spaceBroker.reservationFor({ threadId: "a", turnId: "turn" })).toBeNull();
  });

  it.each(["create"])("%s is an honest refusal without native calls", async (operation) => {
    const { inspect, backend } = setup();
    expect(json(await inspect({ operation }))).toMatchObject({
      error: { code: "computer_space_operation_unsupported" },
    });
    expect(backend.listSpaces).not.toHaveBeenCalled();
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
  });

  it("validates inspect arguments using the canonical schema", async () => {
    const { inspect } = setup();
    expect(
      (await inspect({ operation: "reserve", space_id: 2, user_designated: true })).isError,
    ).toBe(true);
    expect((await inspect({ operation: "reserve", space_id: 2.1 })).isError).toBe(true);
  });
});
