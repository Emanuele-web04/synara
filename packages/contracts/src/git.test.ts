import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  GitSummarizeDiffInput,
} from "./git";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeSummarizeDiffInput = Schema.decodeUnknownSync(GitSummarizeDiffInput);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);

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
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
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
});

describe("GitSummarizeDiffInput", () => {
  it("accepts an optional codexHomePath for diff summaries", () => {
    const parsed = decodeSummarizeDiffInput({
      cwd: "/repo",
      patch: "diff --git a/a b/a",
      codexHomePath: "/tmp/custom-codex-home",
    });

    expect(parsed.codexHomePath).toBe("/tmp/custom-codex-home");
  });
});
