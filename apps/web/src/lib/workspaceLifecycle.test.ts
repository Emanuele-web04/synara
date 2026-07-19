import type { NativeApi, OrchestrationWorktreeWorkspace } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  requestWorkspaceArchive,
  requestWorkspaceRestore,
  WorkspaceLifecycleBlockedError,
} from "./workspaceLifecycle";

const workspace = {
  id: "workspace-1",
  title: "Feature workspace",
  kind: "managed",
} as OrchestrationWorktreeWorkspace;

function api(input: { canStart?: boolean; warnings?: string[]; confirmed?: boolean }) {
  const dispatchCommand = vi.fn().mockResolvedValue({ sequence: 1 });
  const confirm = vi.fn().mockResolvedValue(input.confirmed ?? true);
  const getWorkspaceLifecyclePreflight = vi.fn().mockResolvedValue({
    workspaceId: workspace.id,
    action: "archive",
    lifecycleGeneration: 4,
    canStart: input.canStart ?? true,
    requiresConfirmation: (input.warnings?.length ?? 0) > 0,
    blockers: input.canStart === false ? [{ code: "working-tree-dirty", message: "Dirty." }] : [],
    warnings: (input.warnings ?? []).map((message) => ({
      code: "local-only-commits",
      message,
    })),
  });
  return {
    native: {
      orchestration: { getWorkspaceLifecyclePreflight, dispatchCommand },
      dialogs: { confirm },
    } as unknown as NativeApi,
    confirm,
    dispatchCommand,
    getWorkspaceLifecyclePreflight,
  };
}

describe("workspace lifecycle requests", () => {
  it("fails closed without dispatching when archive preflight is blocked", async () => {
    const harness = api({ canStart: false });
    await expect(
      requestWorkspaceArchive({ api: harness.native, workspace }),
    ).rejects.toBeInstanceOf(WorkspaceLifecycleBlockedError);
    expect(harness.dispatchCommand).not.toHaveBeenCalled();
  });

  it("requires explicit warning confirmation and preserves retained-work copy", async () => {
    const harness = api({ warnings: ["This branch is local only."], confirmed: true });
    await expect(requestWorkspaceArchive({ api: harness.native, workspace })).resolves.toBe(
      "requested",
    );
    expect(harness.confirm).toHaveBeenCalledWith(
      expect.stringContaining("local branch, pull request, conversations, and workspace history"),
    );
    expect(harness.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workspace.archive.request",
        workspaceId: workspace.id,
        expectedGeneration: 4,
        confirmedWarnings: true,
      }),
    );
  });

  it("does not dispatch when warning confirmation is cancelled", async () => {
    const harness = api({ warnings: ["Unpushed commits."], confirmed: false });
    await expect(requestWorkspaceArchive({ api: harness.native, workspace })).resolves.toBe(
      "cancelled",
    );
    expect(harness.dispatchCommand).not.toHaveBeenCalled();
  });

  it("preflights and dispatches restore with the observed generation", async () => {
    const harness = api({});
    await expect(requestWorkspaceRestore({ api: harness.native, workspace })).resolves.toBe(
      "requested",
    );
    expect(harness.getWorkspaceLifecyclePreflight).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      action: "restore",
    });
    expect(harness.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workspace.restore.request",
        workspaceId: workspace.id,
        expectedGeneration: 4,
      }),
    );
  });
});
