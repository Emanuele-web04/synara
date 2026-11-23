import {
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { CompletionRepository } from "./completionRepository.ts";
import {
  assertNotFusionSidekick,
  FUSION_SIDEKICK_CREATION_SOURCE,
  makeFusionTools,
  pickFusionSidekick,
} from "./fusionCoordinator.ts";
import type { ToolContext } from "./toolRuntime.ts";

const pairing = {
  lead: { provider: "claude", model: "claude-opus-4-5" },
  sidekick: { provider: "codex", model: "gpt-5.1-codex-mini" },
} as const;

const leadShell = (overrides: Record<string, unknown> = {}) =>
  ({
    id: ThreadId.makeUnsafe("lead-1"),
    title: "Lead",
    projectId: "project-1",
    creationSource: "synara_mcp",
    parentThreadId: null,
    runtimeMode: "approval-required",
    interactionMode: "chat",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    latestTurn: null,
    fusion: pairing,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const sidekickThread = (leadId = "lead-1") =>
  ({
    id: ThreadId.makeUnsafe("sidekick-1"),
    creationSource: FUSION_SIDEKICK_CREATION_SOURCE,
    parentThreadId: ThreadId.makeUnsafe(leadId),
    deletedAt: null,
  }) as unknown as OrchestrationThread;

const sidekickShell = () =>
  leadShell({
    id: ThreadId.makeUnsafe("sidekick-1"),
    creationSource: FUSION_SIDEKICK_CREATION_SOURCE,
    parentThreadId: ThreadId.makeUnsafe("lead-1"),
    fusion: null,
  });

const makeDeps = (overrides: {
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  /** Shells returned by requireThreadShell, keyed by thread id. */
  readonly shells?: Readonly<Record<string, OrchestrationThreadShell>>;
  readonly detail?: OrchestrationThread;
  readonly snapshots?: ReadonlyArray<Record<string, unknown>>;
}) => {
  const dispatched: Array<Record<string, unknown>> = [];
  const enqueue = vi.fn(() => Effect.void);
  const deps = {
    snapshotQuery: {
      getSnapshot: () => Effect.succeed({ threads: overrides.threads ?? [] }),
      getThreadDetailById: () =>
        Effect.succeed(overrides.detail ? Option.some(overrides.detail) : Option.none()),
    } as unknown as ProjectionSnapshotQueryShape,
    orchestrationEngine: {
      dispatch: (command: Record<string, unknown>) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: 1 });
      },
    } as unknown as OrchestrationEngineShape,
    completions: { enqueue } as unknown as CompletionRepository,
    listUsage: () => Effect.succeed((overrides.snapshots ?? []) as never),
    requireThreadShell: (threadId: string) =>
      Effect.succeed(overrides.shells?.[threadId] ?? leadShell({ id: threadId })),
    assertCallerMayDriveThread: () => Effect.void,
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  };
  const tools = makeFusionTools(deps);
  return { tools, dispatched, enqueue };
};

const context = (callerThreadId = "lead-1") =>
  ({ callerThreadId, callerTurnId: "turn-1" }) as unknown as ToolContext;

const callTool = (
  tools: ReadonlyArray<{
    definition: { name: string };
    handler: (a: Record<string, unknown>, c: ToolContext) => unknown;
  }>,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => {
  const tool = tools.find((entry) => entry.definition.name === name);
  expect(tool).toBeDefined();
  return Effect.runPromise(
    tool!.handler(args, ctx) as Effect.Effect<{
      readonly isError?: boolean;
      readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    }>,
  );
};

const resultJson = (result: { content: ReadonlyArray<{ type: string; text: string }> }) =>
  JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe("synara_fusion_delegate", () => {
  it("creates the sidekick lazily with inherited environment fields", async () => {
    const { tools, dispatched, enqueue } = makeDeps({ threads: [] });
    const result = await callTool(
      tools,
      "synara_fusion_delegate",
      { task: "rename the button", brief: "keep it minimal" },
      context(),
    );
    expect(result.isError).toBeUndefined();
    expect(resultJson(result)).toMatchObject({ created: true, status: "running" });

    const create = dispatched.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({
      projectId: "project-1",
      modelSelection: pairing.sidekick,
      runtimeMode: "approval-required",
      interactionMode: "chat",
      envMode: "local",
      worktreePath: null,
      parentThreadId: "lead-1",
      creationSource: FUSION_SIDEKICK_CREATION_SOURCE,
      sourceThreadId: "lead-1",
      sourceTurnId: "turn-1",
      subagentRole: "sidekick",
      fusion: pairing,
    });
    const turn = dispatched.find((command) => command.type === "thread.turn.start");
    expect(turn).toBeDefined();
    expect((turn!.message as { text: string }).text).toContain("rename the button");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ creatorThreadId: "lead-1" }));
  });

  it("reuses the existing sidekick instead of creating a second one", async () => {
    const { tools, dispatched } = makeDeps({
      threads: [sidekickThread()],
      shells: { "sidekick-1": sidekickShell() },
    });
    const result = await callTool(
      tools,
      "synara_fusion_delegate",
      { task: "second task", brief: "ctx" },
      context(),
    );
    expect(resultJson(result)).toMatchObject({
      sidekickThreadId: "sidekick-1",
      created: false,
    });
    expect(dispatched.every((command) => command.type !== "thread.create")).toBe(true);
    expect(dispatched.some((command) => command.type === "thread.turn.start")).toBe(true);
  });

  it("rejects delegation from a fusion sidekick (no recursion)", async () => {
    const { tools, dispatched } = makeDeps({
      shells: { "sidekick-1": sidekickShell() },
    });
    const result = await callTool(
      tools,
      "synara_fusion_delegate",
      { task: "nested", brief: "ctx" },
      context("sidekick-1"),
    );
    expect(result.isError).toBe(true);
    expect(dispatched).toHaveLength(0);
  });

  it("rejects delegation when the caller has no fusion pairing", async () => {
    const { tools } = makeDeps({ shells: { "lead-1": leadShell({ fusion: null }) } });
    const result = await callTool(
      tools,
      "synara_fusion_delegate",
      { task: "x", brief: "y" },
      context(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("no fusion pairing");
  });
});

describe("synara_fusion_feedback", () => {
  it("routes lead feedback to its sidekick", async () => {
    const { tools, dispatched } = makeDeps({
      threads: [sidekickThread()],
      shells: { "sidekick-1": sidekickShell() },
    });
    const result = await callTool(
      tools,
      "synara_fusion_feedback",
      { message: "also update the icon", mode: "steer" },
      context(),
    );
    expect(resultJson(result)).toMatchObject({
      targetThreadId: "sidekick-1",
      dispatched: "steer",
    });
    const turn = dispatched.find((command) => command.type === "thread.turn.start");
    expect(turn).toMatchObject({ threadId: "sidekick-1", dispatchMode: "steer" });
  });

  it("denies feedback from a fusion sidekick", async () => {
    const { tools, dispatched } = makeDeps({
      shells: { "sidekick-1": sidekickShell() },
    });
    const result = await callTool(
      tools,
      "synara_fusion_feedback",
      { message: "done, with one caveat" },
      context("sidekick-1"),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("cannot create threads or delegate");
    expect(dispatched).toHaveLength(0);
  });

  it("fails on a lead with no sidekick yet", async () => {
    const { tools } = makeDeps({ threads: [] });
    const result = await callTool(tools, "synara_fusion_feedback", { message: "ping" }, context());
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No fusion sidekick");
  });
});

describe("assertNotFusionSidekick", () => {
  it("fails for sidekicks and passes for normal threads", async () => {
    await expect(
      Effect.runPromise(
        assertNotFusionSidekick({ creationSource: FUSION_SIDEKICK_CREATION_SOURCE }),
      ),
    ).rejects.toThrow("cannot create threads or delegate");
    await Effect.runPromise(assertNotFusionSidekick({ creationSource: "synara_mcp" }));
    await Effect.runPromise(assertNotFusionSidekick({ creationSource: null }));
  });
});

describe("pickFusionSidekick", () => {
  const candidates = [
    { provider: "codex", instanceId: "codex", model: "m1" },
    { provider: "claudeAgent", instanceId: "claudeAgent", model: "m2" },
    { provider: "grok", instanceId: "grok", model: "m3" },
  ] as const;

  const snapshot = (provider: string, usedPercent: number) => ({
    provider,
    updatedAt: "2026-01-01T00:00:00Z",
    limits: [{ window: "weekly", usedPercent }],
    usageLines: [],
    source: "test",
  });

  it("prefers the candidate with the most quota headroom", () => {
    const picked = pickFusionSidekick(
      candidates as never,
      [snapshot("codex", 80), snapshot("claudeAgent", 20), snapshot("grok", 50)] as never,
    );
    expect(picked?.provider).toBe("claudeAgent");
  });

  it("skips exhausted candidates and falls back to unknown-quota ones", () => {
    const picked = pickFusionSidekick(
      candidates as never,
      [
        snapshot("codex", 100),
        snapshot("claudeAgent", 100),
        // grok has no snapshot: unknown quota stays eligible.
      ] as never,
    );
    expect(picked?.provider).toBe("grok");
  });

  it("returns null only when every candidate is provably exhausted", () => {
    expect(
      pickFusionSidekick(
        candidates as never,
        [snapshot("codex", 100), snapshot("claudeAgent", 100), snapshot("grok", 100)] as never,
      ),
    ).toBeNull();
  });
});

describe("auto sidekick + retargeting", () => {
  const autoPairing = {
    lead: { provider: "claudeAgent", model: "opus" },
    sidekick: { provider: "codex", model: "m1" },
    autoSidekick: true,
    sidekickCandidates: [
      { provider: "codex", model: "m1" },
      { provider: "grok", model: "m3" },
    ],
  } as const;

  const quota = (provider: string, usedPercent: number) => ({
    provider,
    updatedAt: "2026-01-01T00:00:00Z",
    limits: [{ window: "weekly", usedPercent }],
    usageLines: [],
    source: "test",
  });

  it("creates the sidekick on the candidate with headroom", async () => {
    const { tools, dispatched } = makeDeps({
      threads: [],
      shells: { "lead-1": leadShell({ fusion: autoPairing }) },
      snapshots: [quota("codex", 100), quota("grok", 10)],
    });
    const result = await callTool(
      tools,
      "synara_fusion_delegate",
      { task: "t", brief: "b" },
      context(),
    );
    expect(result.isError).toBeUndefined();
    const create = dispatched.find((command) => command.type === "thread.create");
    expect((create?.modelSelection as { provider: string }).provider).toBe("grok");
  });

  it("retargets an exhausted sidekick and posts synara.fusion.retargeted", async () => {
    const existing = sidekickThread();
    const shell = {
      ...sidekickShell(),
      modelSelection: { provider: "codex", model: "m1" },
    } as unknown as OrchestrationThreadShell;
    const { tools, dispatched } = makeDeps({
      threads: [existing],
      shells: {
        "lead-1": leadShell({ fusion: autoPairing }),
        "sidekick-1": shell,
      },
      snapshots: [quota("codex", 100), quota("grok", 10)],
    });
    const result = await callTool(
      tools,
      "synara_fusion_delegate",
      { task: "t", brief: "b" },
      context(),
    );
    expect(result.isError).toBeUndefined();
    const meta = dispatched.find((command) => command.type === "thread.meta.update");
    expect(meta).toMatchObject({ threadId: "sidekick-1" });
    const activity = dispatched.find(
      (command) =>
        command.type === "thread.activity.append" &&
        (command.activity as { kind: string }).kind === "synara.fusion.retargeted",
    );
    expect(activity).toMatchObject({ threadId: "lead-1" });
    const turn = dispatched.find((command) => command.type === "thread.turn.start");
    expect((turn?.modelSelection as { provider: string }).provider).toBe("grok");
  });
});
