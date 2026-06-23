import type { OrchestrationThreadRuntime } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildRuntimePlanFromDefaults,
  isTerminalRuntimeStatus,
  parsePortsInput,
  type RuntimePlanDefaults,
  resolveDefaultRemoteProvider,
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

  it("renders explicit remote sandbox copy for remote runtimes", () => {
    const presentation = resolveRuntimeHeaderPresentation(
      makeRuntime({ provider: "daytona", status: "provisioning" }),
    );
    expect(presentation.show).toBe(true);
    expect(presentation.label).toBe("Remote sandbox");
    expect(presentation.detailLabel).toBe("Provisioning on Daytona");
    expect(presentation.text).toBe("Remote sandbox: Provisioning on Daytona");
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
  it("enables stop/destroy/snapshot/refresh for a running instance", () => {
    const actions = resolveRuntimeActions(makeRuntime({}));
    const byKind = Object.fromEntries(actions.map((action) => [action.kind, action]));
    expect(byKind.stop?.enabled).toBe(true);
    expect(byKind.destroy?.enabled).toBe(true);
    expect(byKind.snapshot?.enabled).toBe(true);
    expect(byKind.refresh?.enabled).toBe(true);
    expect(byKind.stop?.disabledReason).toBeNull();
  });

  it("disables stop for a terminal instance but keeps destroy/snapshot enabled", () => {
    const actions = resolveRuntimeActions(
      makeRuntime({
        status: "stopped",
        instance: {
          id: "inst-1" as never,
          provider: "fake",
          status: "stopped",
          rootPath: "/tmp/fake",
          failureReason: null,
          createdAt: "2026-01-01T00:00:00.000Z" as never,
          updatedAt: "2026-01-01T00:00:00.000Z" as never,
        },
      }),
    );
    const byKind = Object.fromEntries(actions.map((action) => [action.kind, action]));
    expect(byKind.stop?.enabled).toBe(false);
    expect(byKind.stop?.disabledReason).toBe("Runtime instance is already stopped.");
    expect(byKind.destroy?.enabled).toBe(true);
    expect(byKind.snapshot?.enabled).toBe(true);
  });

  it("reports no-instance reasons and disables lifecycle actions when there is no instance", () => {
    const actions = resolveRuntimeActions(makeRuntime({ instance: null, status: "pending" }));
    const byKind = Object.fromEntries(actions.map((action) => [action.kind, action]));
    expect(byKind.stop?.enabled).toBe(false);
    expect(byKind.stop?.disabledReason).toBe("No active runtime instance to stop.");
    expect(byKind.destroy?.enabled).toBe(false);
    expect(byKind.snapshot?.enabled).toBe(false);
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

describe("buildRuntimePlanFromDefaults", () => {
  const BLANK: RuntimePlanDefaults = {
    provider: "fake",
    snapshotId: null,
    cpu: "",
    memoryMb: "",
    timeoutSeconds: "",
    ports: "",
    persistent: "",
  };

  it("builds a remote plan with resources, ports, persistence, and provider kind", () => {
    const plan = buildRuntimePlanFromDefaults(
      {
        provider: "daytona",
        snapshotId: null,
        cpu: "2",
        memoryMb: "4096",
        timeoutSeconds: "600",
        ports: "3000",
        persistent: "true",
      },
      "codex",
    );
    expect(plan.targetKind).toBe("remote-runtime");
    expect(plan.provider).toBe("daytona");
    expect(plan.resources).toEqual({ cpu: 2, memoryMb: 4096 });
    expect(plan.timeoutSeconds).toBe(600);
    expect(plan.ports).toEqual([3000]);
    expect(plan.persistent).toBe(true);
    expect(plan.providerKind).toBe("codex");
  });

  it("omits resources/timeout when blank, and ports defaults to empty", () => {
    const plan = buildRuntimePlanFromDefaults(BLANK, undefined);
    expect(plan.resources).toBeUndefined();
    expect(plan.timeoutSeconds).toBeUndefined();
    expect(plan.ports).toEqual([]);
    expect(plan.persistent).toBe(false);
  });

  it("ignores non-positive or non-numeric resource defaults", () => {
    const plan = buildRuntimePlanFromDefaults(
      { ...BLANK, cpu: "0", memoryMb: "abc", timeoutSeconds: "-5" },
      undefined,
    );
    expect(plan.resources).toBeUndefined();
    expect(plan.timeoutSeconds).toBeUndefined();
  });

  it("threads a trimmed snapshot id and treats blank as null", () => {
    expect(
      buildRuntimePlanFromDefaults({ ...BLANK, snapshotId: "  snap-7  " }, undefined).snapshotId,
    ).toBe("snap-7");
    expect(
      buildRuntimePlanFromDefaults({ ...BLANK, snapshotId: "   " }, undefined).snapshotId,
    ).toBeNull();
    expect(buildRuntimePlanFromDefaults(BLANK, undefined).snapshotId).toBeNull();
  });

  it("treats persistent='true' as on and anything else as off", () => {
    expect(
      buildRuntimePlanFromDefaults({ ...BLANK, persistent: "true" }, undefined).persistent,
    ).toBe(true);
    expect(
      buildRuntimePlanFromDefaults({ ...BLANK, persistent: "false" }, undefined).persistent,
    ).toBe(false);
  });
});

describe("resolveDefaultRemoteProvider", () => {
  it("uses a configured remote provider verbatim", () => {
    expect(resolveDefaultRemoteProvider("daytona")).toBe("daytona");
    expect(resolveDefaultRemoteProvider("vercel-sandbox")).toBe("vercel-sandbox");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(resolveDefaultRemoteProvider("  modal  ")).toBe("modal");
  });

  it("falls back to fake for unset, no-preference, or unknown values", () => {
    expect(resolveDefaultRemoteProvider("")).toBe("fake");
    expect(resolveDefaultRemoteProvider("local")).toBe("fake");
    expect(resolveDefaultRemoteProvider("gibberish")).toBe("fake");
  });
});
