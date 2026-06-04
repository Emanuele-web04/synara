import type { OrchestrationThreadRuntime } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildRuntimePlanFromDraft,
  DEFAULT_RUNTIME_PLAN_DRAFT,
  isTerminalRuntimeStatus,
  parsePortsInput,
  resolveRuntimeActions,
  resolveRuntimeHeaderPresentation,
  resolveRuntimeStatusTone,
} from "./runtimePresentation";

function makeRuntime(overrides: Partial<OrchestrationThreadRuntime>): OrchestrationThreadRuntime {
  return {
    threadId: "thread-1" as OrchestrationThreadRuntime["threadId"],
    targetKind: "remote-runtime",
    provider: "fake",
    role: "agent",
    status: "running",
    instance: {
      id: "inst-1" as never,
      provider: "fake",
      status: "running",
      rootPath: "/tmp/fake",
      failureReason: null,
      createdAt: "2026-01-01T00:00:00.000Z" as never,
      updatedAt: "2026-01-01T00:00:00.000Z" as never,
    },
    processes: [],
    routes: [],
    snapshots: [],
    leases: [],
    lastActivityAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z" as never,
    ...overrides,
  };
}

describe("resolveRuntimeHeaderPresentation", () => {
  it("hides the chip for local/worktree and missing runtime", () => {
    expect(resolveRuntimeHeaderPresentation(null).show).toBe(false);
    expect(resolveRuntimeHeaderPresentation(makeRuntime({ targetKind: "local" })).show).toBe(false);
    expect(resolveRuntimeHeaderPresentation(makeRuntime({ targetKind: "worktree" })).show).toBe(
      false,
    );
  });

  it("renders 'Runtime: <provider> · <status>' for remote runtimes", () => {
    const presentation = resolveRuntimeHeaderPresentation(
      makeRuntime({ provider: "daytona", status: "provisioning" }),
    );
    expect(presentation.show).toBe(true);
    expect(presentation.text).toBe("Runtime: Daytona · Provisioning");
    expect(presentation.tone).toBe("pending");
  });
});

describe("resolveRuntimeStatusTone", () => {
  it("maps lifecycle states to tones", () => {
    expect(resolveRuntimeStatusTone("running")).toBe("active");
    expect(resolveRuntimeStatusTone("failed")).toBe("error");
    expect(resolveRuntimeStatusTone("destroyed")).toBe("terminal");
    expect(resolveRuntimeStatusTone("idle")).toBe("idle");
  });
});

describe("isTerminalRuntimeStatus", () => {
  it("flags only terminal states", () => {
    expect(isTerminalRuntimeStatus("destroyed")).toBe(true);
    expect(isTerminalRuntimeStatus("archived")).toBe(true);
    expect(isTerminalRuntimeStatus("running")).toBe(false);
    expect(isTerminalRuntimeStatus("failed")).toBe(false);
  });
});

describe("resolveRuntimeActions", () => {
  it("disables lifecycle actions with honest reasons and enables refresh when a runtime exists", () => {
    const actions = resolveRuntimeActions(makeRuntime({}));
    const byKind = Object.fromEntries(actions.map((action) => [action.kind, action]));
    expect(byKind.stop?.enabled).toBe(false);
    expect(byKind.destroy?.enabled).toBe(false);
    expect(byKind.snapshot?.enabled).toBe(false);
    expect(byKind.refresh?.enabled).toBe(true);
    expect(byKind.stop?.disabledReason).toContain("not yet exposed");
  });

  it("reports no-instance reasons when there is no instance", () => {
    const actions = resolveRuntimeActions(makeRuntime({ instance: null, status: "pending" }));
    const stop = actions.find((action) => action.kind === "stop");
    expect(stop?.disabledReason).toBe("No active runtime instance to stop.");
  });

  it("disables refresh when there is no runtime at all", () => {
    const refresh = resolveRuntimeActions(null).find((action) => action.kind === "refresh");
    expect(refresh?.enabled).toBe(false);
  });
});

describe("parsePortsInput", () => {
  it("parses, dedupes, and rejects invalid ports", () => {
    expect(parsePortsInput("3000, 8080 3000")).toEqual([3000, 8080]);
    expect(parsePortsInput("0 70000 abc 443")).toEqual([443]);
    expect(parsePortsInput("")).toEqual([]);
  });
});

describe("buildRuntimePlanFromDraft", () => {
  it("returns null when the draft is not remote-enabled (preserves local default)", () => {
    expect(buildRuntimePlanFromDraft(DEFAULT_RUNTIME_PLAN_DRAFT, "codex")).toBeNull();
  });

  it("builds a remote plan with resources, ports, and provider kind", () => {
    const plan = buildRuntimePlanFromDraft(
      {
        ...DEFAULT_RUNTIME_PLAN_DRAFT,
        enabled: true,
        provider: "daytona",
        cpu: 2,
        memoryMb: 4096,
        timeoutSeconds: 600,
        ports: [3000],
        persistent: true,
      },
      "codex",
    );
    expect(plan).not.toBeNull();
    expect(plan?.targetKind).toBe("remote-runtime");
    expect(plan?.provider).toBe("daytona");
    expect(plan?.resources).toEqual({ cpu: 2, memoryMb: 4096 });
    expect(plan?.timeoutSeconds).toBe(600);
    expect(plan?.ports).toEqual([3000]);
    expect(plan?.persistent).toBe(true);
    expect(plan?.providerKind).toBe("codex");
  });

  it("omits resources when none are set", () => {
    const plan = buildRuntimePlanFromDraft(
      { ...DEFAULT_RUNTIME_PLAN_DRAFT, enabled: true },
      undefined,
    );
    expect(plan?.resources).toBeUndefined();
    expect(plan?.ports).toEqual([]);
  });
});
