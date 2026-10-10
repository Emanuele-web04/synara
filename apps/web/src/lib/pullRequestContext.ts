// FILE: pullRequestContext.ts
// Purpose: Shared helpers for GitHub item context cards — the composer attachment that
//   "Repair" / "Add to chat" in the PR menu and the inbox's Send to agent / Ask create instead
//   of pasting a long prompt into the editor. A card is about a pull request or, with
//   `itemKind: "issue"`, an issue. A card shows a short title + subtitle; its full prompt rides to the
//   provider in a trailing <pull_request_context> block and is parsed back out to render
//   the same card in the transcript.
// Layer: Web composer utility
// Depends on: nothing (kept import-free so both composer state and message display can
//   consume it without cycles).

/** What the card asks the agent to do. Drives the icon and the accessible labels. */
export const PULL_REQUEST_CONTEXT_SCOPES = [
  "reference",
  "comments",
  "checks",
  "conflicts",
  "everything",
] as const;
export type PullRequestContextScope = (typeof PULL_REQUEST_CONTEXT_SCOPES)[number];

/** What the card is about. Cards stored before issues existed have no kind: a pull request. */
export type PullRequestContextItemKind = "pullRequest" | "issue";

export interface PullRequestContextDraft {
  id: string;
  createdAt: string;
  scope: PullRequestContextScope;
  /** Absent means a pull request, so drafts and transcripts written earlier still parse. */
  itemKind?: PullRequestContextItemKind;
  /** The item's number and URL (named for pull requests, which came first). */
  prNumber: number;
  prUrl: string;
  title: string;
  subtitle: string;
  text: string;
}

export interface ParsedPullRequestContextEntry {
  index: number;
  scope: PullRequestContextScope;
  itemKind: PullRequestContextItemKind;
  prNumber: number;
  prUrl: string;
  title: string;
  subtitle: string;
  text: string;
}

export interface ExtractedPullRequestContexts {
  promptText: string;
  pullRequestContexts: ParsedPullRequestContextEntry[];
}

const TRAILING_PULL_REQUEST_CONTEXT_BLOCK_PATTERN =
  /\n*<pull_request_context>\n([\s\S]*?)\n<\/pull_request_context>\s*$/;

interface SerializedPullRequestContextEntry {
  readonly scope: PullRequestContextScope;
  readonly itemKind?: "issue";
  readonly prNumber: number;
  readonly prUrl: string;
  readonly title: string;
  readonly subtitle: string;
  readonly text: string;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function isPullRequestContextScope(value: unknown): value is PullRequestContextScope {
  return (
    typeof value === "string" &&
    (PULL_REQUEST_CONTEXT_SCOPES as ReadonlyArray<string>).includes(value)
  );
}

// null when the card has nothing to send — an empty prompt would attach a bubble contributing nothing
export function normalizePullRequestContext(
  draft: PullRequestContextDraft,
): PullRequestContextDraft | null {
  const id = draft.id.trim();
  const text = normalizeText(draft.text);
  const title = normalizeLine(draft.title);
  if (id.length === 0 || text.length === 0 || title.length === 0) {
    return null;
  }
  if (!isPullRequestContextScope(draft.scope)) {
    return null;
  }
  if (!Number.isInteger(draft.prNumber) || draft.prNumber <= 0) {
    return null;
  }
  return {
    id,
    createdAt: draft.createdAt,
    scope: draft.scope,
    ...(draft.itemKind === "issue" ? { itemKind: "issue" as const } : {}),
    prNumber: draft.prNumber,
    prUrl: draft.prUrl.trim(),
    title,
    subtitle: normalizeLine(draft.subtitle),
    text,
  };
}

export function normalizePullRequestContexts(
  contexts: ReadonlyArray<PullRequestContextDraft>,
): PullRequestContextDraft[] {
  const normalized: PullRequestContextDraft[] = [];
  const seenIds = new Set<string>();
  for (const context of contexts) {
    const entry = normalizePullRequestContext(context);
    if (!entry || seenIds.has(entry.id)) {
      continue;
    }
    seenIds.add(entry.id);
    normalized.push(entry);
  }
  return normalized;
}

/**
 * Cards for the same PR + scope replace each other: clicking "Failing checks" twice must
 * not stack two identical bubbles, but a fresher snapshot should win over a stale one.
 */
export function pullRequestContextDedupKey(
  context: Pick<PullRequestContextDraft, "scope" | "prNumber" | "prUrl">,
): string {
  return `${context.scope}\u0000${context.prNumber}\u0000${context.prUrl}`;
}

export function pullRequestContextItemLabel(
  context: Pick<PullRequestContextDraft, "itemKind" | "prNumber">,
): string {
  return `${context.itemKind === "issue" ? "Issue" : "PR"} #${context.prNumber}`;
}

export function formatPullRequestContextTitleSeed(
  contexts: ReadonlyArray<Pick<PullRequestContextDraft, "title" | "prNumber" | "itemKind">>,
): string | null {
  const first = contexts[0];
  if (!first) {
    return null;
  }
  const itemLabel = pullRequestContextItemLabel(first);
  return contexts.length === 1 ? `${first.title} on ${itemLabel}` : itemLabel;
}

export function buildPullRequestContextBlock(
  contexts: ReadonlyArray<PullRequestContextDraft>,
): string {
  const usable = normalizePullRequestContexts(contexts);
  if (usable.length === 0) {
    return "";
  }
  const payload: SerializedPullRequestContextEntry[] = usable.map((context) =>
    // Only issue cards carry a kind, so pull request blocks stay byte-identical to older ones.
    context.itemKind === "issue"
      ? {
          scope: context.scope,
          itemKind: "issue",
          prNumber: context.prNumber,
          prUrl: context.prUrl,
          title: context.title,
          subtitle: context.subtitle,
          text: context.text,
        }
      : {
          scope: context.scope,
          prNumber: context.prNumber,
          prUrl: context.prUrl,
          title: context.title,
          subtitle: context.subtitle,
          text: context.text,
        },
  );
  return ["<pull_request_context>", JSON.stringify(payload), "</pull_request_context>"].join("\n");
}

export function appendPullRequestContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<PullRequestContextDraft>,
): string {
  const block = buildPullRequestContextBlock(contexts);
  const trimmed = prompt.trim();
  if (block.length === 0) {
    return trimmed;
  }
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

function parseEntries(block: string): ParsedPullRequestContextEntry[] {
  try {
    const parsed: unknown = JSON.parse(block.trim());
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const candidate = entry as Partial<Record<keyof SerializedPullRequestContextEntry, unknown>>;
      if (
        !isPullRequestContextScope(candidate.scope) ||
        typeof candidate.text !== "string" ||
        typeof candidate.title !== "string"
      ) {
        return [];
      }
      const prNumber = typeof candidate.prNumber === "number" ? candidate.prNumber : 0;
      return [
        {
          index: index + 1,
          scope: candidate.scope,
          itemKind: candidate.itemKind === "issue" ? "issue" : "pullRequest",
          prNumber,
          prUrl: typeof candidate.prUrl === "string" ? candidate.prUrl : "",
          title: candidate.title,
          subtitle: typeof candidate.subtitle === "string" ? candidate.subtitle : "",
          text: candidate.text,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function extractTrailingPullRequestContexts(prompt: string): ExtractedPullRequestContexts {
  const match = TRAILING_PULL_REQUEST_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, pullRequestContexts: [] };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  return { promptText, pullRequestContexts: parseEntries(match[1] ?? "") };
}
