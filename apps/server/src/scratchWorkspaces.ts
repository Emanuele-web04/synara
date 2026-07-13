// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). Files agents create here are workspace-equivalent, so the
//          local-preview allowlist also treats this root as servable.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ThreadId } from "@synara/contracts";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";

function scratchWorkspaceSegment(threadId: ThreadId): string {
  const raw = String(threadId);
  const safePrefix = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/g, "")
    .slice(0, 64);
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safePrefix || "thread"}-${digest}`;
}

export function ensureIsolatedScratchWorkspace(threadId: ThreadId): string {
  const workspaceRoot = path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME);
  const workspaceDir = path.join(workspaceRoot, scratchWorkspaceSegment(threadId));
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}
