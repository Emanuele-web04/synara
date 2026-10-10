import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeHistoryPage {
  readonly messages: ReadonlyArray<SessionMessage>;
  readonly nextCursor: string | null;
}

/**
 * Run after the SDK selects the native message chain. This function is also
 * embedded in the account-isolated SDK child, so keep it self-contained.
 */
export function selectClaudeHistoryPage(
  messages: ReadonlyArray<SessionMessage>,
  before?: string,
): ClaudeHistoryPage {
  const end = before === undefined ? messages.length : messages.findIndex((m) => m.uuid === before);
  if (end < 0) throw new Error("The imported Claude history boundary is no longer available.");
  const selected: SessionMessage[] = [];
  let bytes = 0;
  let index = end - 1;
  for (; index >= 0; index -= 1) {
    const entry = messages[index]!;
    const message = entry.message as { content?: unknown } | null;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const content = message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((part: { type?: unknown; text?: unknown }) =>
                part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
              )
              .join("\n")
          : "";
    if (!text.trim()) continue;
    // Only display text crosses the child-process boundary. Tool results,
    // images and thinking remain in the native copy used for continuation.
    const projected = { ...entry, message: { content: text } };
    const size = Buffer.byteLength(JSON.stringify(projected));
    if (size > 1024 * 1024) {
      throw new Error(
        "A Claude message is too large to display during import (over 1 MiB). The native conversation has not been truncated.",
      );
    }
    if (selected.length > 0 && bytes + size > 1024 * 1024) break;
    selected.push(projected);
    bytes += size;
    if (selected.length === 20) {
      index -= 1;
      break;
    }
  }
  const oldest = selected.at(-1);
  return { messages: selected.reverse(), nextCursor: index >= 0 && oldest ? oldest.uuid : null };
}
