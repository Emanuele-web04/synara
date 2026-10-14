import type { ProjectDigestFocusItem, ThreadId } from "@synara/contracts";
import {
  sanitizeProjectDigestFocusTitle,
  sanitizeProjectDigestSummary,
} from "@synara/shared/projectAgent";

export { sanitizeProjectDigestFocusTitle, sanitizeProjectDigestSummary };

export type ProjectFocusRowState = "open" | "done" | "archived";

export type ProjectFocusRow = {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly threadId: ThreadId | null;
  readonly state: ProjectFocusRowState;
};

export function projectDigestFocusRows(
  items: ReadonlyArray<ProjectDigestFocusItem>,
): ReadonlyArray<ProjectFocusRow> {
  return items.map((item) => ({
    id: item.id,
    title: sanitizeProjectDigestFocusTitle(item.title),
    detail: null,
    threadId: item.sourceThreadId ?? null,
    state: "open",
  }));
}

export function rewriteThreadIdsAsMarkdownLinks(
  text: string,
  threads: ReadonlyArray<{ readonly id: string; readonly title: string }>,
): string {
  if (text.length === 0) return text;
  let next = text;
  // Coordinator messages sometimes cite threads as `[label](synara://thread/<title>)`
  // — with raw spaces in the target — which markdown cannot parse at all.
  // Resolve the target (id or title, raw or %-encoded) into a `thread://` link
  // when it names a known thread; otherwise %-encode it so it still renders.
  const threadByKey = new Map<string, { id: string; title: string }>();
  for (const thread of threads) {
    threadByKey.set(thread.id.toLowerCase(), thread);
    const title = thread.title.trim();
    if (title.length > 0) threadByKey.set(title.toLowerCase(), thread);
  }
  next = next.replace(
    /\[([^\]]+)\]\(synara:\/\/thread\/([^)\s]+(?:\s[^)\s]+)*)\)/g,
    (match, label: string, target: string) => {
      let decoded = target;
      try {
        decoded = decodeURIComponent(target).trim();
      } catch {
        // Malformed %-encoding: keep the raw target.
      }
      const thread = threadByKey.get(decoded.toLowerCase());
      return thread
        ? `[${label}](thread://${thread.id})`
        : `[${label}](synara://thread/${encodeURIComponent(decoded)})`;
    },
  );
  for (const thread of threads) {
    const escapedId = thread.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const label = thread.title.trim().length > 0 ? thread.title.trim() : "Thread";
    const markdownLink = `[${label}](thread://${thread.id})`;
    next = next.replace(
      new RegExp(`\\[([^\\]]+)\\]\\(thread://${escapedId}\\)`, "g"),
      markdownLink,
    );
    next = next.replace(new RegExp(`thread://${escapedId}(?!\\))`, "g"), markdownLink);
    next = next.replace(new RegExp(`(?<!\\[|thread://)\\b${escapedId}\\b`, "g"), markdownLink);
  }
  return next;
}
