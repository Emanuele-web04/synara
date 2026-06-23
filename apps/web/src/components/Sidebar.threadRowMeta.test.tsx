import {
  ExecutionInstanceId,
  ThreadId,
  type OrchestrationThreadRuntime,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadRowMetaChips } from "./Sidebar.threadRowMeta";
import { resolveRuntimeHeaderPresentation } from "../lib/runtimePresentation";

type ThreadMetaInput = Parameters<typeof resolveThreadRowMetaChips>[0]["thread"];

function makeRuntime(
  overrides: Partial<OrchestrationThreadRuntime> = {},
): OrchestrationThreadRuntime {
  const provider = overrides.provider ?? "daytona";
  const status = overrides.status ?? "running";
  return {
    threadId: ThreadId.makeUnsafe("thread-sidebar-runtime"),
    targetKind: "remote-runtime",
    provider,
    role: "agent",
    status,
    instance: {
      id: ExecutionInstanceId.makeUnsafe("runtime-instance-sidebar"),
      provider,
      status,
      rootPath: "/workspace/project",
      failureReason: null,
      createdAt: "2026-03-04T12:00:00.000Z" as never,
      updatedAt: "2026-03-04T12:00:01.000Z" as never,
    },
    processes: [],
    routes: [],
    snapshots: [],
    leases: [],
    lastActivityAt: null,
    updatedAt: "2026-03-04T12:00:01.000Z" as never,
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadMetaInput> = {}): ThreadMetaInput {
  return {
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    envMode: "local",
    worktreePath: null,
    handoff: null,
    runtimePresentation: null,
    ...overrides,
  };
}

describe("resolveThreadRowMetaChips", () => {
  it("adds a remote sandbox chip for remote runtime threads", () => {
    const chips = resolveThreadRowMetaChips({
      thread: makeThread({
        runtimePresentation: resolveRuntimeHeaderPresentation(
          makeRuntime({ provider: "daytona", status: "running" }),
        ),
      }),
      includeHandoffBadge: true,
    });

    expect(chips.map((chip) => chip.id)).toContain("runtime");
    expect(chips.find((chip) => chip.id === "runtime")?.tooltip).toBe(
      "Remote sandbox: Running on Daytona",
    );
  });

  it("does not add a runtime chip for local threads", () => {
    const chips = resolveThreadRowMetaChips({
      thread: makeThread(),
      includeHandoffBadge: true,
    });

    expect(chips.some((chip) => chip.id === "runtime")).toBe(false);
  });
});
