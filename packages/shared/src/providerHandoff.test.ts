import { describe, expect, it } from "vitest";
import { ModelSelection } from "@synara/contracts";
import { Schema } from "effect";
import {
  isProviderHandoffActivity,
  resolvePendingProviderHandoff,
  retainProviderHandoffHistory,
  providerHandoffModelSelectionsEqual,
} from "./providerHandoff";

const source = {
  provider: "codex",
  instanceId: "codex-work",
  model: "gpt-5.4",
} satisfies ModelSelection;
const target = {
  provider: "pi",
  instanceId: "pi-work",
  model: "vendor/model",
} satisfies ModelSelection;
const request = (id: string) => ({
  kind: "provider.handoff.requested",
  payload: {
    handoffCommandId: id,
    sourceModelSelection: source,
    targetModelSelection: target,
  },
});

describe("durable provider handoff state", () => {
  it("matches a legacy default instance after actual persisted selection decoding", () => {
    const legacy: ModelSelection = { provider: "claudeAgent", model: "claude-sonnet-4-6" };
    const decoded = Schema.decodeUnknownSync(ModelSelection)(JSON.parse(JSON.stringify(legacy)));
    expect(decoded.instanceId).toBe("claudeAgent");
    expect(providerHandoffModelSelectionsEqual(legacy, decoded)).toBe(true);
    expect(
      providerHandoffModelSelectionsEqual(legacy, { ...decoded, instanceId: "claude-work" }),
    ).toBe(false);
    expect(
      providerHandoffModelSelectionsEqual(legacy, { ...decoded, model: "claude-opus-4-6" }),
    ).toBe(false);
  });
  it("preserves account-scoped selections through a persisted request", () => {
    expect(resolvePendingProviderHandoff(JSON.parse(JSON.stringify([request("a")])))).toEqual({
      handoffCommandId: "a",
      sourceModelSelection: source,
      targetModelSelection: target,
    });
  });
  it.each(["provider.handoff", "provider.handoff.failed", "provider.handoff.completed"])(
    "only a matching %s outcome settles the latest request",
    (kind) => {
      const rows = [request("a"), request("b"), { kind, payload: { handoffCommandId: "a" } }];
      expect(resolvePendingProviderHandoff(rows)?.handoffCommandId).toBe("b");
      expect(
        resolvePendingProviderHandoff([...rows, { kind, payload: { handoffCommandId: "b" } }]),
      ).toBeNull();
    },
  );
  it("ignores malformed requests and ordinary activity payloads", () => {
    expect(
      resolvePendingProviderHandoff([
        {
          kind: "provider.handoff.requested",
          payload: {
            handoffCommandId: "bad",
            sourceModelSelection: {},
            targetModelSelection: target,
          },
        },
        { kind: "tool.completed", payload: request("forged").payload },
      ]),
    ).toBeNull();
    expect(
      resolvePendingProviderHandoff([
        request("a"),
        { kind: "tool.completed", payload: { handoffCommandId: "a" } },
      ])?.handoffCommandId,
    ).toBe("a");
  });
  it("retains the full transition path outside the ordinary activity window", () => {
    const path = [
      request("a"),
      { kind: "provider.handoff", payload: { handoffCommandId: "a" } },
      request("b"),
    ];
    const work = Array.from({ length: 2010 }, (_, id) => ({
      kind: "tool.completed",
      payload: { id },
    }));
    const retained = retainProviderHandoffHistory([...path, ...work], 2000);
    expect(retained.filter(isProviderHandoffActivity)).toEqual(path);
    expect(retained.filter((row) => row.kind === "tool.completed")).toEqual(work.slice(-2000));
    expect(resolvePendingProviderHandoff(retained)?.handoffCommandId).toBe("b");
  });
});
