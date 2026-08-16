// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). The production root lives inside Synara's private state tree.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
import path from "node:path";

import type { ThreadId } from "@synara/contracts";
import { resolveSynaraHomeDirectory } from "@synara/shared/synaraHome";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";
import { ensurePrivateDirectorySync } from "./privatePathPermissions";

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
  workspaceRoot = path.join(resolveSynaraHomeDirectory(), SCRATCH_WORKSPACES_DIRNAME),
): string {
  const workspaceDir = path.join(workspaceRoot, scratchWorkspaceSegment(threadId));
  ensurePrivateDirectorySync(workspaceRoot);
  ensurePrivateDirectorySync(workspaceDir);
  return workspaceDir;
}
