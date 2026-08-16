// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). The root stays in a per-user OS-temporary container so it is
//          outside project ancestry and remains eligible for system cleanup.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
import { lstatSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type { ThreadId } from "@synara/contracts";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";
import { ensurePrivateDirectorySync } from "./privatePathPermissions";

function scratchOwnerSegment(): string {
  const owner =
    typeof process.getuid === "function" ? `uid:${String(process.getuid())}` : homedir();
  return createHash("sha256").update(owner).digest("hex").slice(0, 16);
}

export function resolveScratchWorkspacesRoot(): string {
  const privateTempRoot = path.join(tmpdir(), `.synara-${scratchOwnerSegment()}`);
  return path.join(privateTempRoot, SCRATCH_WORKSPACES_DIRNAME);
}

function scratchWorkspaceSegment(threadId: ThreadId): string {
  const raw = String(threadId);
  const safePrefix = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/g, "")
    .slice(0, 64);
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safePrefix || "thread"}-${digest}`;
}

function isOwnedRealDirectory(directoryPath: string): boolean {
  try {
    const stat = lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return typeof process.getuid !== "function" || stat.uid === process.getuid();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function migrateLegacyScratchWorkspace(
  legacyWorkspaceRoot: string,
  workspaceRoot: string,
  workspaceSegment: string,
): void {
  const workspaceDir = path.join(workspaceRoot, workspaceSegment);
  const legacyWorkspaceDir = path.join(legacyWorkspaceRoot, workspaceSegment);
  if (
    isOwnedRealDirectory(workspaceDir) ||
    !isOwnedRealDirectory(legacyWorkspaceRoot) ||
    !isOwnedRealDirectory(legacyWorkspaceDir)
  ) {
    return;
  }

  // Tighten both old paths before moving user content out of the former
  // process-wide temp root. O_NOFOLLOW inside the helper rejects symlink swaps.
  ensurePrivateDirectorySync(legacyWorkspaceRoot);
  ensurePrivateDirectorySync(legacyWorkspaceDir);
  try {
    renameSync(legacyWorkspaceDir, workspaceDir);
  } catch (cause) {
    // Another concurrent session may have completed the same migration.
    if (!isOwnedRealDirectory(workspaceDir)) throw cause;
  }
}

export function ensureIsolatedScratchWorkspace(
  threadId: ThreadId,
  workspaceRoot = resolveScratchWorkspacesRoot(),
  legacyWorkspaceRoot?: string,
): string {
  const defaultWorkspaceRoot = resolveScratchWorkspacesRoot();
  const workspaceSegment = scratchWorkspaceSegment(threadId);
  const workspaceDir = path.join(workspaceRoot, workspaceSegment);
  if (workspaceRoot === defaultWorkspaceRoot) {
    ensurePrivateDirectorySync(path.dirname(workspaceRoot));
  }
  ensurePrivateDirectorySync(workspaceRoot);
  const legacyRoot =
    legacyWorkspaceRoot ??
    (workspaceRoot === defaultWorkspaceRoot
      ? path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME)
      : undefined);
  if (legacyRoot) {
    migrateLegacyScratchWorkspace(legacyRoot, workspaceRoot, workspaceSegment);
  }
  ensurePrivateDirectorySync(workspaceDir);
  return workspaceDir;
}
