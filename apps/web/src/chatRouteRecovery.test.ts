import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  syncServerReadModel: vi.fn(),
  syncServerShellSnapshot: vi.fn(),
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

function makeApi(input: {
  shell: OrchestrationShellSnapshot;
  snapshot: OrchestrationReadModel;
  repaired: OrchestrationReadModel;
}) {
  const orchestration = {
    getShellSnapshot: vi.fn().mockResolvedValue(input.shell),
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
  });

  it("repairs without full-history hydration when the shell snapshot only contains projects", async () => {
    const shell = shellSnapshot({ projects: [{ id: "project-1" }] });
    const snapshot = readModel({ projects: [{ id: "project-1" }] });
    const repaired = readModel({
      projects: [{ id: "project-1" }],
      threads: [{ id: "thread-1" }],
    });
    const { api, orchestration } = makeApi({ shell, snapshot, repaired });

    await expect(refreshEmptyRouteRestoreSnapshot(api)).resolves.toBe(true);

    expect(orchestration.getSnapshot).not.toHaveBeenCalled();
    expect(orchestration.repairState).toHaveBeenCalledTimes(1);
    expect(storeMocks.syncServerShellSnapshot).toHaveBeenCalledWith(shell);
    expect(storeMocks.syncServerReadModel).toHaveBeenCalledTimes(1);
    expect(storeMocks.syncServerReadModel).toHaveBeenCalledWith(repaired);
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
