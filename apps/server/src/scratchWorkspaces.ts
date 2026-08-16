// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). The root stays in a per-user OS-temporary container so it is
//          outside project ancestry and remains eligible for system cleanup.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
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

function repairLegacyScratchWorkspace(
  legacyWorkspaceRoot: string,
  workspaceSegment: string,
): string | undefined {
  const legacyWorkspaceDir = path.join(legacyWorkspaceRoot, workspaceSegment);
  if (!isOwnedRealDirectory(legacyWorkspaceRoot) || !isOwnedRealDirectory(legacyWorkspaceDir)) {
    return undefined;
  }

  // Preserve historical absolute paths while making the legacy workspace safe
  // to resume. O_NOFOLLOW inside the helper rejects symlink swaps.
  ensurePrivateDirectorySync(legacyWorkspaceRoot);
  ensurePrivateDirectorySync(legacyWorkspaceDir);
  return legacyWorkspaceDir;
}

export function ensureIsolatedScratchWorkspace(
  threadId: ThreadId,
  workspaceRoot = resolveScratchWorkspacesRoot(),
  legacyWorkspaceRoot?: string,
): string {
  const defaultWorkspaceRoot = resolveScratchWorkspacesRoot();
  const workspaceSegment = scratchWorkspaceSegment(threadId);
  const workspaceDir = path.join(workspaceRoot, workspaceSegment);
  const legacyRoot =
    legacyWorkspaceRoot ??
    (workspaceRoot === defaultWorkspaceRoot
      ? path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME)
      : undefined);
  if (legacyRoot) {
    const repairedLegacyWorkspace = repairLegacyScratchWorkspace(legacyRoot, workspaceSegment);
    if (repairedLegacyWorkspace) return repairedLegacyWorkspace;
  }
  if (workspaceRoot === defaultWorkspaceRoot) {
    ensurePrivateDirectorySync(path.dirname(workspaceRoot));
  }
  ensurePrivateDirectorySync(workspaceRoot);
  ensurePrivateDirectorySync(workspaceDir);
  return workspaceDir;
}

export function resolveScratchWorkspaceCwd(
  threadId: ThreadId,
  persistedCwd?: string,
  roots: {
    readonly workspaceRoot?: string;
    readonly legacyWorkspaceRoot?: string;
  } = {},
): string {
  const workspaceRoot = roots.workspaceRoot ?? resolveScratchWorkspacesRoot();
  const legacyWorkspaceRoot =
    roots.legacyWorkspaceRoot ?? path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME);
  if (!persistedCwd) {
    return ensureIsolatedScratchWorkspace(threadId, workspaceRoot, legacyWorkspaceRoot);
  }

  const legacyWorkspace = path.join(legacyWorkspaceRoot, scratchWorkspaceSegment(threadId));
  if (path.resolve(persistedCwd) !== path.resolve(legacyWorkspace)) return persistedCwd;

  return ensureIsolatedScratchWorkspace(threadId, workspaceRoot, legacyWorkspaceRoot);
}
