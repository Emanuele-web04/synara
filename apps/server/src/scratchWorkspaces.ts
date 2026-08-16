// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). The root stays in a per-user OS-temporary container so it is
//          outside project ancestry and remains eligible for system cleanup.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
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
  ensurePrivateDirectorySync(privateTempRoot);
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

export function ensureIsolatedScratchWorkspace(
  threadId: ThreadId,
  workspaceRoot = resolveScratchWorkspacesRoot(),
): string {
  const workspaceDir = path.join(workspaceRoot, scratchWorkspaceSegment(threadId));
  ensurePrivateDirectorySync(workspaceRoot);
  ensurePrivateDirectorySync(workspaceDir);
  return workspaceDir;
}
