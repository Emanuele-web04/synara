// Purpose: Pure commit-message, recovery-detail, and git-output helpers for GitManager.
// Layer: Layers (pure helpers; no Effect/service binding).
// Exports: gitManagerError, limitContext, sanitizeCommitMessage, deriveFallbackCommitSubject,
//   createFallbackCommitSuggestion, sanitizeProgressText, isCommitAction, formatCommitMessage,
//   parseCustomCommitMessage, extractBranchFromRef, prioritizeRemoteNames, appendUnique,
//   canonicalizeExistingPath, combineGitMessages, buildFailedLocalHandoffRecoveryDetail,
//   buildFailedLocalTransferDetail, buildFailedWorktreeHandoffRecoveryDetail,
//   buildFailedWorktreeTransferDetail.

import { realpathSync } from "node:fs";

import type { GitStackedAction } from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { GitManagerError } from "../Errors.ts";
import type {
  CommitAndBranchSuggestion,
  FailedLocalHandoffRecovery,
  FailedLocalTransferRecovery,
  FailedWorktreeHandoffRecovery,
  FailedWorktreeTransferRecovery,
} from "./GitManager.types.ts";
import { MAX_PROGRESS_TEXT_LENGTH } from "./GitManager.types.ts";

export function gitManagerError(
  operation: string,
  detail: string,
  cause?: unknown,
): GitManagerError {
  return new GitManagerError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

export function sanitizeCommitMessage(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}

function summarizePathForCommitSubject(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    return "project files";
  }

  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? trimmed;
}

export function deriveFallbackCommitSubject(stagedSummary: string): string {
  const lines = stagedSummary
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "Update project files";
  }

  const firstEntry = lines[0]?.split("\t") ?? [];
  const rawStatus = firstEntry[0]?.trim().toUpperCase() ?? "";
  const firstPath = firstEntry.at(-1)?.trim() ?? "";
  const fileLabel = summarizePathForCommitSubject(firstPath);

  if (lines.length === 1) {
    if (rawStatus.startsWith("A")) {
      return `Add ${fileLabel}`;
    }
    if (rawStatus.startsWith("D")) {
      return `Remove ${fileLabel}`;
    }
    if (rawStatus.startsWith("R")) {
      return `Rename ${fileLabel}`;
    }
    return `Update ${fileLabel}`;
  }

  const uniqueTopLevelDirs = Array.from(
    new Set(
      lines
        .map((line) => {
          const entry = line.split("\t");
          const filePath = entry.at(-1)?.trim() ?? "";
          return filePath.split("/")[0]?.trim() ?? "";
        })
        .filter((segment) => segment.length > 0),
    ),
  );

  if (uniqueTopLevelDirs.length === 1) {
    return `Update ${uniqueTopLevelDirs[0]} files`;
  }

  return "Update project files";
}

export function createFallbackCommitSuggestion(input: {
  stagedSummary: string;
  includeBranch?: boolean;
}): CommitAndBranchSuggestion {
  const subject = deriveFallbackCommitSubject(input.stagedSummary);
  return {
    subject,
    body: "",
    ...(input.includeBranch ? { branch: sanitizeFeatureBranchName(subject) } : {}),
    commitMessage: formatCommitMessage(subject, ""),
  };
}

export function sanitizeProgressText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= MAX_PROGRESS_TEXT_LENGTH) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_PROGRESS_TEXT_LENGTH).trimEnd();
}

export function isCommitAction(
  action: GitStackedAction,
): action is "commit" | "commit_push" | "commit_push_pr" {
  return action === "commit" || action === "commit_push" || action === "commit_push_pr";
}

export function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

export function buildFailedLocalHandoffRecoveryDetail(
  baseMessage: string,
  recovery: FailedLocalHandoffRecovery,
): string {
  return `${baseMessage} ${[
    recovery.worktreeRecreated
      ? "The original worktree was recreated."
      : "The original worktree could not be recreated automatically.",
    recovery.worktreeChangesRestored
      ? "Recovered worktree changes were reapplied."
      : "Recovered worktree changes remain in the Git stash.",
    recovery.localChangesRestored
      ? "Previous local changes were restored."
      : "Previous local changes remain in the Git stash.",
    ...recovery.recoveryNotes,
  ].join(" ")}`.trim();
}

export function buildFailedLocalTransferDetail(
  baseMessage: string,
  recovery: FailedLocalTransferRecovery,
): string {
  return `${baseMessage} ${[
    recovery.worktreeRecreated
      ? "The original worktree was recreated."
      : "The original worktree could not be recreated automatically.",
    recovery.worktreeChangesRestored
      ? "The thread changes were restored to that worktree."
      : "The thread changes remain in the Git stash.",
    recovery.localCheckoutRestored
      ? "Local checkout was restored."
      : "Local checkout could not be fully restored automatically.",
    recovery.localChangesRestored
      ? "Previous local changes were restored."
      : "Previous local changes remain in the Git stash.",
    ...recovery.recoveryNotes,
  ].join(" ")}`.trim();
}

export function buildFailedWorktreeHandoffRecoveryDetail(
  baseMessage: string,
  recovery: FailedWorktreeHandoffRecovery,
): string {
  return `${baseMessage} ${[
    recovery.checkoutRestored
      ? "Local checkout was restored."
      : "Local checkout could not be fully restored automatically.",
    recovery.stashRestored
      ? "Previous local changes were restored."
      : "Previous local changes remain in the Git stash.",
    ...recovery.recoveryNotes,
  ].join(" ")}`.trim();
}

export function buildFailedWorktreeTransferDetail(
  baseMessage: string,
  recovery: FailedWorktreeTransferRecovery,
): string {
  return `${baseMessage} ${[
    recovery.worktreeRemoved
      ? "The new worktree was removed."
      : "The new worktree could not be removed automatically.",
    recovery.checkoutRestored
      ? "Local checkout was restored."
      : "Local checkout could not be fully restored automatically.",
    recovery.stashRestored
      ? "Previous local changes were restored."
      : "Previous local changes remain in the Git stash. Run `git stash list` in Local to recover them.",
    ...recovery.recoveryNotes,
  ].join(" ")}`.trim();
}

export function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

export function extractBranchFromRef(ref: string): string {
  const normalized = ref.trim();

  if (normalized.startsWith("refs/remotes/")) {
    const withoutPrefix = normalized.slice("refs/remotes/".length);
    const firstSlash = withoutPrefix.indexOf("/");
    if (firstSlash === -1) {
      return withoutPrefix.trim();
    }
    return withoutPrefix.slice(firstSlash + 1).trim();
  }

  const firstSlash = normalized.indexOf("/");
  if (firstSlash === -1) {
    return normalized;
  }
  return normalized.slice(firstSlash + 1).trim();
}

export function prioritizeRemoteNames(remoteNames: readonly string[]): string[] {
  const normalized = remoteNames
    .map((remoteName) => remoteName.trim())
    .filter((remoteName) => remoteName.length > 0);
  if (!normalized.includes("origin")) {
    return normalized;
  }
  return ["origin", ...normalized.filter((remoteName) => remoteName !== "origin")];
}

export function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}

export function canonicalizeExistingPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

export function combineGitMessages(stdout: string, stderr: string): string | null {
  const parts = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n").trim();
}
