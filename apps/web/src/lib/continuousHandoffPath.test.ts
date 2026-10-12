import { EventId, type OrchestrationThreadActivity, type ProviderKind } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  compressContinuousHandoffPath,
  deriveContinuousHandoffPath,
} from "./continuousHandoffPath";

function handoff(
  id: string,
  sourceProvider: ProviderKind,
  targetProvider: ProviderKind,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    kind: "provider.handoff",
    tone: "info",
    summary: "Handoff completed",
    payload: { sourceProvider, targetProvider },
    turnId: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    ...overrides,
  };
}

describe("continuous handoff path", () => {
  it("derives the full durable route and marks each revisit, including repeated loops", () => {
    const route = deriveContinuousHandoffPath([
      handoff("1", "claudeAgent", "grok"),
      handoff("2", "grok", "codex"),
      handoff("3", "codex", "claudeAgent"),
      handoff("4", "claudeAgent", "grok"),
    ]);
    expect(route.map((step) => [step.provider, step.transition])).toEqual([
      ["claudeAgent", "start"],
      ["grok", "forward"],
      ["codex", "forward"],
      ["claudeAgent", "return"],
      ["grok", "return"],
    ]);
  });

  it("uses durable sequence over arrival order or clock skew and deduplicates replayed events", () => {
    const first = handoff("1", "codex", "claudeAgent", {
      sequence: 5,
      createdAt: "2026-10-03T11:00:00.000Z",
    });
    const second = handoff("2", "claudeAgent", "grok", { sequence: 8 });
    expect(
      deriveContinuousHandoffPath([second, first, first]).map((step) => step.provider),
    ).toEqual(["codex", "claudeAgent", "grok"]);
  });

  it("retains timestamp ordering for older unsequenced activities", () => {
    const first = handoff("late-id", "codex", "claudeAgent");
    const second = handoff("early-id", "claudeAgent", "grok", {
      createdAt: "2026-10-03T10:01:00.000Z",
    });
    expect(deriveContinuousHandoffPath([second, first]).map((step) => step.provider)).toEqual([
      "codex",
      "claudeAgent",
      "grok",
    ]);
  });

  it("ignores failed or pending starts, unrelated model changes, and malformed imported payloads", () => {
    const completed = handoff("1", "codex", "claudeAgent");
    const route = deriveContinuousHandoffPath([
      completed,
      handoff("failed", "claudeAgent", "grok", { kind: "provider.handoff.failed", tone: "error" }),
      handoff("starting", "claudeAgent", "grok", { kind: "session.starting" }),
      handoff("model", "claudeAgent", "claudeAgent", { kind: "model.updated" }),
      handoff("invalid", "claudeAgent", "grok", {
        payload: { sourceProvider: "unknown", targetProvider: "grok" },
      }),
      handoff("null", "claudeAgent", "grok", { payload: null }),
    ]);
    expect(route.map((step) => step.provider)).toEqual(["codex", "claudeAgent"]);
    expect(deriveContinuousHandoffPath([])).toEqual([]);
  });

  it("makes gaps explicit instead of fabricating a transition in partial history", () => {
    expect(
      deriveContinuousHandoffPath([
        handoff("1", "codex", "claudeAgent"),
        handoff("2", "grok", "cursor"),
      ]).map((step) => [step.provider, step.transition]),
    ).toEqual([
      ["codex", "start"],
      ["claudeAgent", "forward"],
      ["grok", "gap"],
      ["cursor", "forward"],
    ]);
  });

  it("reconstructs the same route from reloaded activities without extra persisted state", () => {
    const activities = [handoff("1", "codex", "grok"), handoff("2", "grok", "codex")];
    const reloaded = JSON.parse(JSON.stringify(activities)) as OrchestrationThreadActivity[];
    expect(deriveContinuousHandoffPath(reloaded)).toEqual(deriveContinuousHandoffPath(activities));
  });

  it("compresses long routes while preserving the origin, latest provider and return markers", () => {
    const route = deriveContinuousHandoffPath([
      handoff("1", "claudeAgent", "grok"),
      handoff("2", "grok", "codex"),
      handoff("3", "codex", "cursor"),
      handoff("4", "cursor", "claudeAgent"),
      handoff("5", "claudeAgent", "grok"),
    ]);
    expect(compressContinuousHandoffPath(route, 2)).toEqual([
      { kind: "provider", step: route[0] },
      { kind: "overflow", hiddenCount: 4 },
      { kind: "provider", step: route[5] },
    ]);
    expect(route[5]?.transition).toBe("return");
    expect(compressContinuousHandoffPath(route)).toHaveLength(5);
    expect(compressContinuousHandoffPath(route)[1]).toEqual({ kind: "overflow", hiddenCount: 2 });
    expect(compressContinuousHandoffPath(route, 0)).toEqual(
      compressContinuousHandoffPath(route, 2),
    );
    expect(compressContinuousHandoffPath(route, NaN)).toEqual(compressContinuousHandoffPath(route));
  });

  it("does not compress short routes", () => {
    const route = deriveContinuousHandoffPath([handoff("1", "codex", "claudeAgent")]);
    expect(compressContinuousHandoffPath(route)).toEqual(
      route.map((step) => ({ kind: "provider", step })),
    );
  });
});
