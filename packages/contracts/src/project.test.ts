import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectDevServer,
  ProjectDevServerEvent,
  ProjectRunDevServerInput,
  ProjectStopDevServerInput,
} from "./project";

describe("project dev-server contracts", () => {
  it("decodes legacy project-only payloads as the null workspace target", () => {
    const server = Schema.decodeUnknownSync(ProjectDevServer)({
      projectId: "project-1",
      command: "bun run dev",
      cwd: "/repo",
      pid: 123,
      startedAt: "2026-07-16T00:00:00.000Z",
      status: "running",
    });
    const runInput = Schema.decodeUnknownSync(ProjectRunDevServerInput)({
      projectId: "project-1",
      command: "bun run dev",
      cwd: "/repo",
    });
    const stopInput = Schema.decodeUnknownSync(ProjectStopDevServerInput)({
      projectId: "project-1",
    });
    const removedEvent = Schema.decodeUnknownSync(ProjectDevServerEvent)({
      type: "removed",
      projectId: "project-1",
      reason: "exited",
    });

    expect(server.workspaceId).toBeNull();
    expect(runInput.workspaceId).toBeNull();
    expect(stopInput.workspaceId).toBeNull();
    expect(removedEvent).toMatchObject({ workspaceId: null });
  });

  it("preserves a workspace target across descriptors and lifecycle events", () => {
    const server = Schema.decodeUnknownSync(ProjectDevServer)({
      projectId: "project-1",
      workspaceId: "workspace-1",
      command: "bun run dev",
      cwd: "/repo-worktrees/one",
      pid: null,
      startedAt: "2026-07-16T00:00:00.000Z",
      status: "starting",
    });
    const removedEvent = Schema.decodeUnknownSync(ProjectDevServerEvent)({
      type: "removed",
      projectId: "project-1",
      workspaceId: "workspace-1",
      reason: "stopped",
    });

    expect(server.workspaceId).toBe("workspace-1");
    expect(removedEvent).toMatchObject({ workspaceId: "workspace-1" });
  });

  it("preserves optional terminal exit and error detail on removed events", () => {
    const exitedEvent = Schema.decodeUnknownSync(ProjectDevServerEvent)({
      type: "removed",
      projectId: "project-1",
      workspaceId: "workspace-1",
      reason: "exited",
      exitCode: 1,
      exitSignal: null,
    });
    const errorEvent = Schema.decodeUnknownSync(ProjectDevServerEvent)({
      type: "removed",
      projectId: "project-1",
      workspaceId: "workspace-1",
      reason: "exited",
      message: "address already in use",
    });

    expect(exitedEvent).toMatchObject({ exitCode: 1, exitSignal: null });
    expect(errorEvent).toMatchObject({ message: "address already in use" });
  });
});
