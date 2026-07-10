// FILE: chatWorkspaceFolders.ts
// Purpose: Build Codex-style local workspace folders for general chats.
// Layer: Web domain helper
// Exports: date/slug helpers plus unique chat workspace path resolution.

import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";

const FALLBACK_CHAT_WORKSPACE_SLUG = "new-thread";
const MAX_CHAT_WORKSPACE_SLUG_LENGTH = 72;

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/g, "");
}

function preferredPathSeparator(root: string): "\\" | "/" {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

function joinWorkspacePath(root: string, ...segments: readonly string[]): string {
  const separator = preferredPathSeparator(root);
  return [trimTrailingPathSeparators(root), ...segments].filter(Boolean).join(separator);
}

// Uses the user's local calendar day, matching the date-bucketed folders Codex creates.
export function formatChatWorkspaceDate(date: Date): string {
  return [date.getFullYear(), padDatePart(date.getMonth() + 1), padDatePart(date.getDate())].join(
    "-",
  );
}

export function slugifyChatWorkspaceSeed(seed: string): string {
  const normalized = seed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const truncated = normalized.slice(0, MAX_CHAT_WORKSPACE_SLUG_LENGTH).replace(/-+$/g, "");
  return truncated || FALLBACK_CHAT_WORKSPACE_SLUG;
}

export function buildChatWorkspaceFolderPath(input: {
  readonly chatWorkspaceRoot: string;
  readonly createdAt: Date;
  readonly existingWorkspaceRoots: readonly string[];
  readonly titleSeed: string;
}): string {
  const dateSegment = formatChatWorkspaceDate(input.createdAt);
  const baseSlug = slugifyChatWorkspaceSeed(input.titleSeed);

  for (let index = 1; index < 1_000; index += 1) {
    const slug = index === 1 ? baseSlug : `${baseSlug}-${index}`;
    const candidate = joinWorkspacePath(input.chatWorkspaceRoot, dateSegment, slug);
    if (!input.existingWorkspaceRoots.some((root) => workspaceRootsEqual(root, candidate))) {
      return candidate;
    }
  }

  return joinWorkspacePath(input.chatWorkspaceRoot, dateSegment, `${baseSlug}-${Date.now()}`);
}
