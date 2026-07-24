// FILE: threadMentions.ts
// Purpose: Shared `thread://` mention path convention for composer chat mentions.
// Layer: Shared runtime utilities (consumed by both server and web)
// Exports: THREAD_MENTION_PATH_PREFIX, isThreadMentionPath, threadMentionPathForThreadId, threadIdFromThreadMentionPath

export const THREAD_MENTION_PATH_PREFIX = "thread://";

export function isThreadMentionPath(path: string): boolean {
  return path.startsWith(THREAD_MENTION_PATH_PREFIX);
}

export function threadMentionPathForThreadId(threadId: string): string {
  return `${THREAD_MENTION_PATH_PREFIX}${threadId}`;
}

export function threadIdFromThreadMentionPath(path: string): string | null {
  if (!isThreadMentionPath(path)) return null;
  const threadId = path.slice(THREAD_MENTION_PATH_PREFIX.length).trim();
  return threadId.length > 0 ? threadId : null;
}
