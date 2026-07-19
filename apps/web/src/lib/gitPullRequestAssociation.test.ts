import {
  type NativeApi,
  type OrchestrationThreadPullRequest,
  ThreadId,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  persistPullRequestAssociation,
  pullRequestAssociationsEqual,
  resolvePullRequestAssociation,
} from "./gitPullRequestAssociation";

const pullRequest: OrchestrationThreadPullRequest = {
  number: 42,
  title: "Keep workspace PR state",
  url: "https://github.com/acme/synara/pull/42",
  baseBranch: "main",
  headBranch: "feature/workspace-pr",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 12,
  deletions: 3,
  changedFiles: 2,
};

function makeApi(dispatchCommand: ReturnType<typeof vi.fn>): NativeApi {
  return { orchestration: { dispatchCommand } } as unknown as NativeApi;
}

describe("persistPullRequestAssociation", () => {
  it("updates workspace metadata when the thread belongs to a workspace", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 2 }));

    await persistPullRequestAssociation({
      api: makeApi(dispatchCommand),
      threadId: ThreadId.makeUnsafe("thread-1"),
      workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
      pullRequest,
      updatedAt: "2026-07-16T12:00:00.000Z",
    });

    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "workspace.meta.update",
      commandId: expect.any(String),
      workspaceId: "workspace-1",
      lastKnownPr: pullRequest,
      updatedAt: "2026-07-16T12:00:00.000Z",
    });
  });

  it("keeps legacy pull request metadata on the thread", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 2 }));

    await persistPullRequestAssociation({
      api: makeApi(dispatchCommand),
      threadId: ThreadId.makeUnsafe("thread-legacy"),
      workspaceId: null,
      pullRequest,
    });

    expect(dispatchCommand).toHaveBeenCalledWith({
      type: "thread.meta.update",
      commandId: expect.any(String),
      threadId: "thread-legacy",
      lastKnownPr: pullRequest,
    });
  });

  it("propagates persistence failures", async () => {
    const failure = new Error("workspace update failed");
    const dispatchCommand = vi.fn(async () => Promise.reject(failure));

    await expect(
      persistPullRequestAssociation({
        api: makeApi(dispatchCommand),
        threadId: ThreadId.makeUnsafe("thread-1"),
        workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
        pullRequest,
      }),
    ).rejects.toBe(failure);
  });
});

describe("pull request association resolution", () => {
  it("retains persisted state while live GitHub data is unavailable", () => {
    expect(
      resolvePullRequestAssociation({ live: null, persisted: pullRequest, liveUnavailable: true }),
    ).toBe(pullRequest);
  });

  it("does not retain stale state after a successful no-PR result", () => {
    expect(
      resolvePullRequestAssociation({ live: null, persisted: pullRequest, liveUnavailable: false }),
    ).toBeNull();
  });

  it("prefers live state and detects metadata changes", () => {
    const merged = { ...pullRequest, state: "merged" as const };
    expect(
      resolvePullRequestAssociation({
        live: merged,
        persisted: pullRequest,
        liveUnavailable: true,
      }),
    ).toBe(merged);
    expect(pullRequestAssociationsEqual(pullRequest, { ...pullRequest })).toBe(true);
    expect(pullRequestAssociationsEqual(pullRequest, merged)).toBe(false);
  });
});
