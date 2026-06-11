// @vitest-environment happy-dom
// Pins the projection-lag recovery decision tree wired up in useSidebarProjectActions:
// create -> recover, slow-snapshot fallback to local new-thread, duplicate-create recovery,
// and existing-project short-circuit. Asserts observable behavior (dispatch called or not,
// handleNewThread called or not, thrown vs resolved, final isAddingProject) rather than
// internal call counts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { OrchestrationShellSnapshot } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";

const dispatchCommand = vi.fn<(command: unknown) => Promise<void>>();
const getShellSnapshot = vi.fn<() => Promise<OrchestrationShellSnapshot>>();

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand,
      getShellSnapshot,
    },
    dialogs: {
      pickFolder: vi.fn(),
    },
  }),
}));

import { useSidebarProjectActions } from "./useSidebarProjectActions";
import type { Project } from "../types";

const WORKSPACE_ROOT = "/Users/test/project-alpha";

function shellProject(overrides: { id: string; workspaceRoot: string }) {
  return {
    id: ProjectId.makeUnsafe(overrides.id),
    kind: "project",
    title: "Project Alpha",
    workspaceRoot: overrides.workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function shellThread(overrides: { id: string; projectId: string }) {
  return {
    id: overrides.id,
    projectId: ProjectId.makeUnsafe(overrides.projectId),
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
  };
}

function snapshotWith(
  projects: ReturnType<typeof shellProject>[],
  threads: ReturnType<typeof shellThread>[],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects,
    threads,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
}

function emptySnapshot(): OrchestrationShellSnapshot {
  return snapshotWith([], []);
}

interface HookFakes {
  navigate: ReturnType<typeof vi.fn>;
  setProjectExpanded: ReturnType<typeof vi.fn>;
  handleNewThread: ReturnType<typeof vi.fn>;
  syncServerShellSnapshot: ReturnType<typeof vi.fn>;
}

function renderActions(projects: readonly Project[], fakes: HookFakes) {
  return renderHook(() =>
    useSidebarProjectActions({
      projects,
      appSettings: {
        defaultThreadEnvMode: "default",
        sidebarThreadSortOrder: "recent",
      } as never,
      navigate: fakes.navigate as never,
      setProjectExpanded: fakes.setProjectExpanded as never,
      handleNewThread: fakes.handleNewThread as never,
      syncServerShellSnapshot: fakes.syncServerShellSnapshot as never,
    }),
  );
}

function makeFakes(): HookFakes {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    setProjectExpanded: vi.fn(),
    handleNewThread: vi.fn().mockResolvedValue(undefined),
    syncServerShellSnapshot: vi.fn(),
  };
}

const DUPLICATE_ERROR_MESSAGE = (projectId: string) =>
  `Orchestration command invariant failed (project.create): Project '${projectId}' already uses workspace root '${WORKSPACE_ROOT}'.`;

describe("useSidebarProjectActions add-project recovery decision tree", () => {
  beforeEach(() => {
    dispatchCommand.mockReset();
    getShellSnapshot.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy create->recover: opens the new project thread and finishes without error", async () => {
    const fakes = makeFakes();
    // Capture the project id the hook generated so the snapshot can echo it back,
    // mimicking the projection catching up immediately after project.create commits.
    let createdProjectId: string | null = null;
    dispatchCommand.mockImplementation(async (command) => {
      const typed = command as { type?: string; projectId?: string };
      if (typed.type === "project.create" && typed.projectId) {
        createdProjectId = typed.projectId;
      }
      return undefined;
    });
    getShellSnapshot.mockImplementation(async () => {
      if (!createdProjectId) {
        return emptySnapshot();
      }
      return snapshotWith(
        [shellProject({ id: createdProjectId, workspaceRoot: WORKSPACE_ROOT })],
        [shellThread({ id: "thread-1", projectId: createdProjectId })],
      );
    });

    const { result } = renderActions([], fakes);

    await act(async () => {
      await result.current.addProjectFromPath(WORKSPACE_ROOT, { createIfMissing: true });
    });

    expect(dispatchCommand).toHaveBeenCalled();
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({ type: "project.create" });
    expect(fakes.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/$threadId" }));
    // Recovered through the snapshot, so the local new-thread fallback never runs.
    expect(fakes.handleNewThread).not.toHaveBeenCalled();
    expect(result.current.isAddingProject).toBe(false);
    expect(result.current.addProjectError).toBeNull();
  });

  it("slow-snapshot fallback: never-catching snapshot falls back to local handleNewThread without a false sync error", async () => {
    vi.useFakeTimers();
    const fakes = makeFakes();
    dispatchCommand.mockResolvedValue(undefined);
    // Snapshot never catches up: no project ever matches.
    getShellSnapshot.mockResolvedValue(emptySnapshot());

    const { result } = renderActions([], fakes);

    let settled = false;
    let thrown: unknown = null;
    await act(async () => {
      const pending = result.current
        .addProjectFromPath(WORKSPACE_ROOT, { createIfMissing: true })
        .then(() => {
          settled = true;
        })
        .catch((error: unknown) => {
          thrown = error;
        });
      // Drain the catch-up retry loop (delays scale by attempt).
      await vi.runAllTimersAsync();
      await pending;
    });

    expect(thrown).toBeNull();
    expect(settled).toBe(true);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.create" }),
    );
    expect(fakes.handleNewThread).toHaveBeenCalledTimes(1);
    expect(fakes.setProjectExpanded).toHaveBeenCalledWith(expect.anything(), true);
    expect(result.current.isAddingProject).toBe(false);
  });

  it("duplicate-create recovery: resolves without surfacing an error when the project is recoverable", async () => {
    const fakes = makeFakes();
    const duplicateProjectId = ProjectId.makeUnsafe("project-existing");
    dispatchCommand.mockRejectedValue(new Error(DUPLICATE_ERROR_MESSAGE(duplicateProjectId)));
    // The duplicate already exists in the read model, matched by id from the error message.
    getShellSnapshot.mockResolvedValue(
      snapshotWith(
        [shellProject({ id: duplicateProjectId, workspaceRoot: WORKSPACE_ROOT })],
        [shellThread({ id: "thread-dup", projectId: duplicateProjectId })],
      ),
    );

    const { result } = renderActions([], fakes);

    let thrown: unknown = null;
    await act(async () => {
      await result.current
        .addProjectFromPath(WORKSPACE_ROOT, { createIfMissing: true })
        .catch((error: unknown) => {
          thrown = error;
        });
    });

    expect(thrown).toBeNull();
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.create" }),
    );
    expect(fakes.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/$threadId" }));
    expect(result.current.isAddingProject).toBe(false);
    expect(result.current.addProjectError).toBeNull();
  });

  it("existing-project short-circuit: recovers a known project without dispatching project.create", async () => {
    const fakes = makeFakes();
    const existingProjectId = ProjectId.makeUnsafe("project-existing-local");
    const existingProject = {
      id: existingProjectId,
      cwd: WORKSPACE_ROOT,
    } as unknown as Project;
    // First snapshot read (existing-project recovery) already has the project + a thread.
    getShellSnapshot.mockResolvedValue(
      snapshotWith(
        [shellProject({ id: existingProjectId, workspaceRoot: WORKSPACE_ROOT })],
        [shellThread({ id: "thread-existing", projectId: existingProjectId })],
      ),
    );

    const { result } = renderActions([existingProject], fakes);

    await act(async () => {
      await result.current.addProjectFromPath(WORKSPACE_ROOT, { createIfMissing: true });
    });

    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(fakes.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/$threadId" }));
    expect(result.current.isAddingProject).toBe(false);
    expect(result.current.addProjectError).toBeNull();
  });
});
