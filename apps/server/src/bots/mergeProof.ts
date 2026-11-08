// FILE: mergeProof.ts
// Purpose: The SynBot merge proof (HoloBot's rule): Merge is enabled only when the PR's checks
//          are green on its current head and the PR is up to date with its base; red flags from
//          the diff are always shown, never trusted away. An agent's own claims are never read.
// Layer: Pure domain logic (no I/O)
// Exports: evaluateMergeProof, findMergeRedFlags

import type {
  BotMergeProof,
  BotMergeRedFlag,
  PullRequestDetail,
  ThreadId,
} from "@synara/contracts";

const MAX_RED_FLAGS = 24;

const TEST_FILE =
  /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|Tests?\.swift$|(^|\/)test_[^/]+\.py$/i;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const SKIP_MARKER =
  /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@(?:Disabled|Ignore)\b|#\[ignore\]|pytest\.mark\.skip|\bt\.Skip\(|\bXCTSkip\b|\.skip\(\s*["'`]/;
const ASSERTION = /\b(?:expect|assert(?:[A-Z][A-Za-z]*)?|XCTAssert[A-Za-z]*|should)\s*[.(]/;
const FAILURE_IGNORED = /\|\|\s*true\b|continue-on-error:\s*true/;
const TEST_STEP =
  /^\s*(?:-\s*)?run:\s*.*\b(test|vitest|jest|pytest|cargo test|go test|xcodebuild test|swift test|bun run test)\b/i;

interface FileDiff {
  readonly path: string;
  readonly deleted: boolean;
  readonly added: string[];
  readonly removed: string[];
}

function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: { path: string; deleted: boolean; added: string[]; removed: string[] } | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: match?.[2] ?? match?.[1] ?? "", deleted: false, added: [], removed: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("deleted file mode")) {
      current.deleted = true;
    } else if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    } else if (line.startsWith("+")) {
      current.added.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
    }
  }
  return files;
}

const clip = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
};

/** Diff-based red flags: shown on the card, never used to hide anything. */
export function findMergeRedFlags(patch: string): BotMergeRedFlag[] {
  const flags: BotMergeRedFlag[] = [];
  const push = (flag: BotMergeRedFlag) => {
    if (flags.length < MAX_RED_FLAGS) flags.push(flag);
  };
  for (const file of parsePatch(patch)) {
    const isTest = TEST_FILE.test(file.path);
    if (isTest && file.deleted) {
      push({ kind: "test-removed", file: file.path, detail: "Test file deleted" });
      continue;
    }
    for (const line of file.added) {
      if (SKIP_MARKER.test(line)) {
        push({ kind: "test-skipped", file: file.path, detail: clip(line) });
      }
      if (FAILURE_IGNORED.test(line)) {
        push({ kind: "failure-ignored", file: file.path, detail: clip(line) });
      }
    }
    if (isTest) {
      const removedAssertions = file.removed.filter((line) => ASSERTION.test(line)).length;
      const addedAssertions = file.added.filter((line) => ASSERTION.test(line)).length;
      if (removedAssertions > addedAssertions) {
        push({
          kind: "assertion-removed",
          file: file.path,
          detail: `${removedAssertions - addedAssertions} fewer assertion${removedAssertions - addedAssertions === 1 ? "" : "s"}`,
        });
      }
    }
    if (WORKFLOW_FILE.test(file.path)) {
      const removedSteps = file.removed.filter((line) => TEST_STEP.test(line));
      const addedSteps = file.added.filter((line) => TEST_STEP.test(line));
      if (removedSteps.length > addedSteps.length) {
        push({ kind: "ci-step-removed", file: file.path, detail: clip(removedSteps[0]!) });
      }
    }
  }
  return flags;
}

const FAILING_CHECK_STATES = new Set(["failure", "cancelled"]);

/**
 * Builds the proof from a fresh PR detail and its patch. `ready` requires: open and not a draft,
 * at least one check, every check settled with none failing (GitHub's UNSTABLE — non-required
 * checks failing — still blocks: the rule is green on the current head), not behind its base,
 * no conflicts.
 */
export function evaluateMergeProof(input: {
  readonly threadId: ThreadId;
  readonly detail: PullRequestDetail;
  readonly patch: string;
  readonly checkedAt: string;
}): BotMergeProof {
  const { detail } = input;
  const failingChecks = detail.checks
    .filter((check) => FAILING_CHECK_STATES.has(check.status))
    .map((check) => check.name);
  const pending = detail.checks.some((check) => check.status === "pending");
  const checks: BotMergeProof["checks"] =
    detail.checks.length === 0
      ? "none"
      : failingChecks.length > 0
        ? "failing"
        : pending
          ? "pending"
          : "passing";
  const mergeState = (detail.mergeStateStatus ?? "").toUpperCase();
  const behind = mergeState === "BEHIND";
  const conflicts = mergeState === "DIRTY" || detail.mergeability === "conflicting";
  const state: BotMergeProof["state"] =
    detail.state === "merged" ? "merged" : detail.state === "closed" ? "closed" : "open";
  const ready =
    state === "open" &&
    !detail.isDraft &&
    checks === "passing" &&
    !behind &&
    !conflicts &&
    mergeState !== "BLOCKED" &&
    mergeState !== "DRAFT";
  return {
    threadId: input.threadId,
    prNumber: detail.number,
    prUrl: detail.url,
    headSha: detail.commits.at(-1)?.oid ?? "unknown",
    baseBranch: detail.baseBranch,
    state,
    checks,
    failingChecks,
    behind,
    conflicts,
    redFlags: findMergeRedFlags(input.patch),
    additions: detail.additions,
    deletions: detail.deletions,
    changedFiles: detail.changedFiles,
    ready,
    checkedAt: input.checkedAt,
  };
}
