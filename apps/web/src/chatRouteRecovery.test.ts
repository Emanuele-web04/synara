import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationWorkspaceShellSnapshot,
} from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  syncServerReadModel: vi.fn(),
  syncServerShellSnapshot: vi.fn(),
  syncServerWorkspaceShellSnapshot: vi.fn(),
}));

vi.mock("./store", () => ({
  useStore: {
    getState: () => storeMocks,
  },
}));

import { refreshEmptyRouteRestoreSnapshot } from "./chatRouteRecovery";

function shellSnapshot(input: {
  projects?: unknown[];
  threads?: unknown[];
}): OrchestrationShellSnapshot {
  return {
    projects: input.projects ?? [],
    threads: input.threads ?? [],
  } as unknown as OrchestrationShellSnapshot;
}

function readModel(input: { projects?: unknown[]; threads?: unknown[] }): OrchestrationReadModel {
  return {
    projects: input.projects ?? [],
    threads: input.threads ?? [],
  } as unknown as OrchestrationReadModel;
}

function workspaceShellSnapshot(input: {
  projects?: unknown[];
  threads?: unknown[];
  workspaces?: unknown[];
}): OrchestrationWorkspaceShellSnapshot {
  return {
    projects: input.projects ?? [],
    threads: input.threads ?? [],
    workspaces: input.workspaces ?? [],
  } as unknown as OrchestrationWorkspaceShellSnapshot;
}

function makeApi(input: {
  shell: OrchestrationShellSnapshot;
  snapshot: OrchestrationReadModel;
  repaired: OrchestrationReadModel;
  workspaceShell?: OrchestrationWorkspaceShellSnapshot;
}) {
  const orchestration = {
    getCapabilities: vi.fn().mockResolvedValue({
      protocolVersions: input.workspaceShell ? [1, 2] : [1],
      worktreeWorkspacesV2: input.workspaceShell !== undefined,
      canonicalWorkspaceRoutes: input.workspaceShell !== undefined,
    }),
    getShellSnapshot: vi.fn().mockResolvedValue(input.shell),
    getWorkspaceShellSnapshot: vi.fn().mockResolvedValue(input.workspaceShell),
    getSnapshot: vi.fn().mockResolvedValue(input.snapshot),
    repairState: vi.fn().mockResolvedValue(input.repaired),
  };

  return {
    api: { orchestration } as unknown as NativeApi,
    orchestration,
  };
}

describe("refreshEmptyRouteRestoreSnapshot", () => {
  beforeEach(() => {
    storeMocks.syncServerReadModel.mockClear();
    storeMocks.syncServerShellSnapshot.mockClear();
    storeMocks.syncServerWorkspaceShellSnapshot.mockClear();
  });

  it("uses the V2 workspace shell to restore workspace conversations", async () => {
    const workspaceShell = workspaceShellSnapshot({
      projects: [{ id: "project-1" }],
      workspaces: [{ id: "workspace-1" }],
      threads: [{ id: "workspace-conversation" }],
    });
    const { api, orchestration } = makeApi({
      workspaceShell,
      shell: shellSnapshot({}),
      snapshot: readModel({}),
      repaired: readModel({}),
    });

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(true);

    expect(orchestration.getWorkspaceShellSnapshot).toHaveBeenCalledTimes(1);
    expect(storeMocks.syncServerWorkspaceShellSnapshot).toHaveBeenCalledWith(workspaceShell);
    expect(orchestration.getShellSnapshot).not.toHaveBeenCalled();
    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    expect(orchestration.repairState).not.toHaveBeenCalled();
  });

  it("continues to repair when shell and full snapshots only contain projects", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(true);

    expect(orchestration.getSnapshot).toHaveBeenCalledTimes(1);
    expect(orchestration.repairState).toHaveBeenCalledTimes(1);
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
    expect(storeMocks.syncServerReadModel).toHaveBeenNthCalledWith(1, snapshot);
    expect(storeMocks.syncServerReadModel).toHaveBeenNthCalledWith(2, repaired);
  });

  it("stops at the shell snapshot when it already has threads", async () => {
    const shell = shellSnapshot({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(true);

    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    expect(orchestration.repairState).not.toHaveBeenCalled();
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
    expect(storeMocks.syncServerReadModel).not.toHaveBeenCalled();
  });
});
