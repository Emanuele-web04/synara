import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitCreateWorktreeInput,
  GitHandoffThreadInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  GitStatusResult,
  GitSummarizeDiffInput,
} from "./git";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodeHandoffThreadInput = Schema.decodeUnknownSync(GitHandoffThreadInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeSummarizeDiffInput = Schema.decodeUnknownSync(GitSummarizeDiffInput);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeStatusResult = Schema.decodeUnknownSync(GitStatusResult);

describe("GitStatusResult", () => {
  it.each([
    { state: "local_only" },
    { state: "upstream", remoteBranch: "feature/verified" },
    {
      state: "published",
      remoteBranch: "feature/published",
      url: "https://github.com/acme/repo/tree/feature/published",
    },
    { state: "stale_upstream", remoteBranch: "feature/deleted" },
  ])("decodes $state publication state", (publication) => {
    const parsed = decodeStatusResult({
      branch: "feature/status",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: publication.state !== "local_only",
      upstreamBranch: publication.state === "local_only" ? null : "feature/status",
      aheadCount: 0,
      behindCount: 0,
      publication,
      pr: null,
    });

    expect(parsed.publication).toEqual(publication);
  });

  it("decodes explicit bounded-detail metadata", () => {
    const parsed = decodeStatusResult({
      branch: "feature/large-status",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: " leading\nbreak.ts ", insertions: 0, deletions: 0 }],
        insertions: 0,
        deletions: 0,
        totalFiles: 4_542,
        isPartial: true,
        truncated: true,
        statisticsState: "unknown",
      },
      hasUpstream: true,
      upstreamBranch: "feature/large-status",
      aheadCount: 3,
      behindCount: 1,
      pr: null,
    });

    expect(parsed.workingTree).toMatchObject({
      totalFiles: 4_542,
      isPartial: true,
      truncated: true,
      statisticsState: "unknown",
    });
    expect(parsed.workingTree.files[0]?.path).toBe(" leading\nbreak.ts ");
  });

  it("keeps legacy status payloads decodable", () => {
    const parsed = decodeStatusResult({
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      upstreamBranch: null,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    });

    expect(parsed.workingTree.isPartial).toBeUndefined();
    expect(parsed.prUnavailable).toBeUndefined();
  });

  it("decodes explicit unavailable PR discovery", () => {
    const parsed = decodeStatusResult({
      branch: "feature/offline",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      upstreamBranch: "feature/offline",
      aheadCount: 0,
      behindCount: 0,
      pr: null,
      prUnavailable: true,
    });

    expect(parsed.prUnavailable).toBe(true);
  });
});

describe("GitCreateWorktreeInput", () => {
  it("accepts omitted newBranch for existing-branch worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      branch: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newBranch).toBeUndefined();
    expect(parsed.branch).toBe("feature/existing");
  });
});

describe("GitHandoffThreadInput", () => {
  it("carries durable orchestration identity with the Git handoff", () => {
    const parsed = decodeHandoffThreadInput({
      commandId: "command-handoff-1",
      threadId: "thread-handoff-1",
      cwd: "/repo",
      targetMode: "worktree",
      currentBranch: "main",
      worktreePath: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      preferredLocalBranch: "main",
      preferredWorktreeBaseBranch: "main",
      preferredNewWorktreeName: "worktree/handoff",
    });

    expect(parsed.commandId).toBe("command-handoff-1");
    expect(parsed.threadId).toBe("thread-handoff-1");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });

  it("accepts an optional managed worktree path", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
      managedWorktreePath: "/managed/worktrees/pr-42",
    });

    expect(parsed.managedWorktreePath).toBe("/managed/worktrees/pr-42");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/example-org/sample-repo/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        additions: 38,
        deletions: 36,
        changedFiles: 3,
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
    expect(parsed.pullRequest.isDraft).toBe(true);
    expect(parsed.pullRequest.mergeability).toBe("conflicting");
    expect(parsed.pullRequest.additions).toBe(38);
  });
});

describe("GitRunStackedActionInput", () => {
  it("requires a client-provided actionId for progress correlation", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("commit");
  });

  it("accepts an optional codexHomePath for git text generation", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-2",
      cwd: "/repo",
      action: "commit_push",
      codexHomePath: "/tmp/custom-codex-home",
    });

    expect(parsed.codexHomePath).toBe("/tmp/custom-codex-home");
  });

  it("accepts an optional textGenerationModelSelection for provider routing", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-3",
      cwd: "/repo",
      action: "commit",
      textGenerationModelSelection: {
        provider: "opencode",
        model: "openrouter/gpt-oss-120b",
      },
    });

    expect(parsed.textGenerationModelSelection?.provider).toBe("opencode");
    expect(parsed.textGenerationModelSelection?.model).toBe("openrouter/gpt-oss-120b");
  });
});

describe("GitSummarizeDiffInput", () => {
  it("accepts an optional codexHomePath for diff summaries", () => {
    const parsed = decodeSummarizeDiffInput({
      cwd: "/repo",
      scope: "staged",
      codexHomePath: "/tmp/custom-codex-home",
    });

    expect(parsed.codexHomePath).toBe("/tmp/custom-codex-home");
    expect(parsed.scope).toBe("staged");
  });
});
