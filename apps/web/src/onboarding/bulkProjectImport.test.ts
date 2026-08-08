import type { NativeApi, ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { bulkImportProjects, summarizeBulkProjectImport } from "./bulkProjectImport";

const EXISTING_PROJECT_ID = "project-existing" as ProjectId;

function makeApi(overrides?: {
  dispatchCommand?: (command: Record<string, unknown>) => Promise<unknown>;
  getShellSnapshot?: () => Promise<unknown>;
}) {
  const dispatchCommand = vi.fn(async (command: Record<string, unknown>) =>
    overrides?.dispatchCommand ? overrides.dispatchCommand(command) : {},
  );
  const getShellSnapshot = vi.fn(async () =>
    overrides?.getShellSnapshot ? overrides.getShellSnapshot() : { projects: [], threads: [] },
  );
  const api = {
    orchestration: { dispatchCommand, getShellSnapshot },
  } as unknown as NativeApi;
  return { api, dispatchCommand, getShellSnapshot };
}

describe("bulkImportProjects", () => {
  it("dispatches project.create sequentially in candidate order and skips known roots", async () => {
    const { api, dispatchCommand, getShellSnapshot } = makeApi();

    const results = await bulkImportProjects({
      api,
      spaceId: null,
      candidates: [
        { workspaceRoot: "/Users/dev/alpha", existingProjectId: null },
        { workspaceRoot: "/Users/dev/linked/", existingProjectId: null },
        { workspaceRoot: "/Users/dev/beta", existingProjectId: null },
        { workspaceRoot: "/Users/dev/flagged", existingProjectId: EXISTING_PROJECT_ID },
      ],
      existingProjects: [{ id: EXISTING_PROJECT_ID, cwd: "/Users/dev/linked" }],
    });

    const dispatchedRoots = dispatchCommand.mock.calls.map(
      (call) => (call[0] as { workspaceRoot: string }).workspaceRoot,
    );
    expect(dispatchedRoots).toEqual(["/Users/dev/alpha", "/Users/dev/beta"]);
    expect(results.map((result) => result.status)).toEqual([
      "created",
      "existing",
      "created",
      "existing",
    ]);
    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
  });

  it("treats duplicate-create invariant errors as existing and keeps going after failures", async () => {
    const { api } = makeApi({
      dispatchCommand: (command) => {
        const root = command.workspaceRoot as string;
        if (root === "/Users/dev/duplicate") {
          return Promise.reject(
            new Error(
              "Orchestration command invariant failed (project.create): Project 'project-dup' already uses workspace root '/Users/dev/duplicate'.",
            ),
          );
        }
        if (root === "/Users/dev/broken") {
          return Promise.reject(new Error("Project directory does not exist: /Users/dev/broken"));
        }
        return Promise.resolve({});
      },
    });

    const results = await bulkImportProjects({
      api,
      spaceId: null,
      candidates: [
        { workspaceRoot: "/Users/dev/duplicate", existingProjectId: null },
        { workspaceRoot: "/Users/dev/broken", existingProjectId: null },
        { workspaceRoot: "/Users/dev/fine", existingProjectId: null },
      ],
      existingProjects: [],
    });

    expect(results.map((result) => result.status)).toEqual(["existing", "failed", "created"]);
    expect(results[0]?.projectId).toBe("project-dup");
    expect(results[1]?.message).toContain("does not exist");
    expect(summarizeBulkProjectImport(results)).toEqual({ created: 1, existing: 1, failed: 1 });
  });

  it("swallows snapshot refresh failures", async () => {
    const { api } = makeApi({
      getShellSnapshot: () => Promise.reject(new Error("transport closed")),
    });

    const applySnapshot = vi.fn();
    const results = await bulkImportProjects({
      api,
      spaceId: null,
      candidates: [{ workspaceRoot: "/Users/dev/alpha", existingProjectId: null }],
      existingProjects: [],
      applySnapshot,
    });

    expect(results.map((result) => result.status)).toEqual(["created"]);
    expect(applySnapshot).not.toHaveBeenCalled();
  });
});
