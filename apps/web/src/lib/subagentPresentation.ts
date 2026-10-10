// FILE: subagentPresentation.ts
// Purpose: Normalizes subagent identity and status (labels, tones, dots) for sidebar/chat UI.
// Exports: Shared presentation helpers consumed by sidebar rows, chat cards, and thread hydration.

import {
  buildSubagentIdentityDirectory,
  extractSubagentIdentityHints as extractParsedSubagentIdentityHints,
  isWorkerTierSubagentRole,
  resolveSubagentIdentityFromDirectory,
} from "@synara/shared/subagents";
import { formatModelDisplayName } from "@synara/shared/model";

const GENERIC_SUBAGENT_TITLES = new Set([
  "",
  "agent",
  "chat",
  "child thread",
  "conversation",
  "new chat",
  "new conversation",
  "new thread",
  "subagent",
  "thread",
]);

export type SubagentStatusKind = "running" | "completed" | "failed" | "stopped" | "queued" | "idle";

export interface SubagentPresentation {
  primaryLabel: string;
  nickname: string | null;
  role: string | null;
  title: string | null;
  fullLabel: string;
}

type SubagentThreadActivityLike = {
  payload?: unknown;
};

type SubagentThreadLike = {
  id: string;
  title?: string | null | undefined;
  parentThreadId?: string | null | undefined;
  subagentAgentId?: string | null | undefined;
  subagentNickname?: string | null | undefined;
  subagentRole?: string | null | undefined;
  createdAt?: string | null | undefined;
  activities?: ReadonlyArray<SubagentThreadActivityLike> | undefined;
};

// The parent's identity directory plus the first spawn prompt seen per child:
// later collab items (send_input, wait) may carry follow-up messages that the
// shared directory merge would prefer, but the label should name the task.
type ParentSubagentIdentityIndex = {
  directory: ReturnType<typeof buildSubagentIdentityDirectory>;
  firstPromptByProviderThreadId: ReadonlyMap<string, string>;
  firstPromptByAgentId: ReadonlyMap<string, string>;
};

const DEFAULT_SUBAGENT_LABEL = "Subagent";
const SUBAGENT_PROMPT_LABEL_MAX_LENGTH = 60;

const subagentIdentityIndexByActivities = new WeakMap<
  ReadonlyArray<SubagentThreadActivityLike>,
  ParentSubagentIdentityIndex
>();

const siblingThreadIdsByThreads = new WeakMap<
  ReadonlyArray<SubagentThreadLike>,
  Map<string, ReadonlyArray<string>>
>();

// Mirrors the server's prompt-derived child title: first non-empty line,
// whitespace-collapsed, clipped to 60 characters.
function subagentPromptLabel(prompt: string | null | undefined): string | null {
  const line = prompt
    ?.split(/\r?\n/)
    .map((candidate) => normalizeWhitespace(candidate))
    .find((candidate): candidate is string => candidate !== null);
  if (!line) {
    return null;
  }
  return line.length > SUBAGENT_PROMPT_LABEL_MAX_LENGTH
    ? `${line.slice(0, SUBAGENT_PROMPT_LABEL_MAX_LENGTH - 1).trimEnd()}…`
    : line;
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeRole(role: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(role);
  return normalized ? normalized.toLowerCase() : null;
}

// Worker-tier agent types are internal effort carriers; never surface them as a
// role even when persisted thread metadata or titles still contain them.
function suppressWorkerTierRole(role: string | null): string | null {
  return role !== null && isWorkerTierSubagentRole(role) ? null : role;
}

// Placeholders the server persists before identity arrives: "Subagent",
// "Subagent <provider id>" (older builds), and "Subagent [role]".
function isGenericSubagentTitle(title: string | null): boolean {
  if (!title) {
    return true;
  }
  const normalized = title.trim().toLowerCase();
  return (
    GENERIC_SUBAGENT_TITLES.has(normalized) ||
    /^subagent \S+$/.test(normalized) ||
    /^subagent\s*\[[^\]]*\]$/.test(normalized)
  );
}

function parseBracketedSubagentLabel(label: string | null): {
  nickname: string | null;
  role: string | null;
} {
  if (!label) {
    return { nickname: null, role: null };
  }

  const match = /^(.*?)\s*\[([^\]]+)\]$/.exec(label.trim());
  if (!match) {
    return { nickname: null, role: null };
  }

  return {
    nickname: normalizeWhitespace(match[1]),
    role: normalizeRole(match[2]),
  };
}

function capitalizeRoleLabel(role: string | null): string | null {
  if (!role) {
    return null;
  }
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerThreadIdForThread(input: {
  threadId: string;
  parentThreadId: string | null;
}): string {
  const threadId = normalizeWhitespace(input.threadId) ?? input.threadId;
  const parentThreadId = normalizeWhitespace(input.parentThreadId);
  if (!parentThreadId) {
    return threadId;
  }
  const prefix = `subagent:${parentThreadId}:`;
  return threadId.startsWith(prefix) ? threadId.slice(prefix.length) : threadId;
}

function resolveSubagentIdentityFromParentActivity(input: {
  thread: Pick<SubagentThreadLike, "id" | "parentThreadId" | "subagentAgentId">;
  threads: ReadonlyArray<SubagentThreadLike>;
}): {
  nickname: string | null;
  role: string | null;
  promptLabel: string | null;
} | null {
  const parentThreadId = normalizeWhitespace(input.thread.parentThreadId);
  if (!parentThreadId) {
    return null;
  }

  const parentThread = input.threads.find((thread) => thread.id === parentThreadId);
  if (!parentThread) {
    return null;
  }

  const activities = parentThread.activities ?? [];
  const identityIndex =
    subagentIdentityIndexByActivities.get(activities) ??
    (() => {
      const hints = activities.flatMap((activity) => {
        const root = asRecord(activity?.payload);
        const data = asRecord(root?.data);
        const item = asRecord(data?.item) ?? data ?? root;
        return item ? extractParsedSubagentIdentityHints(item) : [];
      });
      const firstPromptByProviderThreadId = new Map<string, string>();
      const firstPromptByAgentId = new Map<string, string>();
      for (const hint of hints) {
        const promptLabel = subagentPromptLabel(hint.prompt);
        if (!promptLabel) {
          continue;
        }
        const providerThreadId = normalizeWhitespace(hint.providerThreadId);
        if (providerThreadId && !firstPromptByProviderThreadId.has(providerThreadId)) {
          firstPromptByProviderThreadId.set(providerThreadId, promptLabel);
        }
        const agentId = normalizeWhitespace(hint.agentId);
        if (agentId && !firstPromptByAgentId.has(agentId)) {
          firstPromptByAgentId.set(agentId, promptLabel);
        }
      }
      const nextIndex: ParentSubagentIdentityIndex = {
        directory: buildSubagentIdentityDirectory(hints),
        firstPromptByProviderThreadId,
        firstPromptByAgentId,
      };
      subagentIdentityIndexByActivities.set(activities, nextIndex);
      return nextIndex;
    })();
  const providerThreadId = providerThreadIdForThread({
    threadId: input.thread.id,
    parentThreadId,
  });
  const agentId = normalizeWhitespace(input.thread.subagentAgentId);
  const resolved = resolveSubagentIdentityFromDirectory(identityIndex.directory, {
    providerThreadId,
    agentId,
  });

  if (!resolved) {
    return null;
  }

  const resolvedAgentId = agentId ?? normalizeWhitespace(resolved.agentId);
  const resolvedProviderThreadId = normalizeWhitespace(resolved.providerThreadId);
  return {
    nickname: normalizeWhitespace(resolved.nickname),
    role: normalizeRole(resolved.role),
    promptLabel:
      identityIndex.firstPromptByProviderThreadId.get(providerThreadId) ??
      (resolvedProviderThreadId
        ? identityIndex.firstPromptByProviderThreadId.get(resolvedProviderThreadId)
        : undefined) ??
      (resolvedAgentId ? identityIndex.firstPromptByAgentId.get(resolvedAgentId) : undefined) ??
      subagentPromptLabel(resolved.prompt),
  };
}

// "Subagent N": the child's 1-based position among threads sharing its parent,
// ordered by creation time then id. Null when the thread list does not include
// the child itself, since siblings cannot be counted reliably then.
function resolveSubagentSiblingLabel(input: {
  thread: Pick<SubagentThreadLike, "id" | "parentThreadId">;
  threads: ReadonlyArray<SubagentThreadLike>;
}): string | null {
  const parentThreadId = normalizeWhitespace(input.thread.parentThreadId);
  if (!parentThreadId) {
    return null;
  }
  let siblingIdsByParent = siblingThreadIdsByThreads.get(input.threads);
  if (!siblingIdsByParent) {
    siblingIdsByParent = new Map();
    siblingThreadIdsByThreads.set(input.threads, siblingIdsByParent);
  }
  let siblingIds = siblingIdsByParent.get(parentThreadId);
  if (!siblingIds) {
    siblingIds = input.threads
      .filter((thread) => normalizeWhitespace(thread.parentThreadId) === parentThreadId)
      .toSorted((left, right) => {
        const leftCreatedAt = left.createdAt ?? "";
        const rightCreatedAt = right.createdAt ?? "";
        if (leftCreatedAt !== rightCreatedAt) {
          return leftCreatedAt < rightCreatedAt ? -1 : 1;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .map((thread) => thread.id)
      .filter((id, index, ids) => ids.indexOf(id) === index);
    siblingIdsByParent.set(parentThreadId, siblingIds);
  }
  const index = siblingIds.indexOf(input.thread.id);
  return index >= 0 ? `${DEFAULT_SUBAGENT_LABEL} ${index + 1}` : null;
}

// Stable 32-bit hash for per-subagent picks (accent color, avatar glyph).
export function hashLabelSeed(seed: string): number {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function resolveSubagentPresentation(input: {
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  // Shown when no nickname, role, or usable title is known (defaults to
  // "Subagent"). Provider ids are never shown as a label.
  placeholderLabel?: string | null | undefined;
}): SubagentPresentation {
  const explicitNickname = normalizeWhitespace(input.nickname);
  const explicitRole = suppressWorkerTierRole(normalizeRole(input.role));
  const normalizedTitle = normalizeWhitespace(input.title);
  const parsedTitle = parseBracketedSubagentLabel(normalizedTitle);
  const parsedTitleRole = suppressWorkerTierRole(parsedTitle.role);
  // Titles persisted as "Nickname [worker-low]" drop the worker-tier suffix.
  const titleWithoutWorkerRole =
    parsedTitle.role !== null && parsedTitleRole === null ? parsedTitle.nickname : normalizedTitle;
  const parsedTitleNickname = isGenericSubagentTitle(parsedTitle.nickname)
    ? null
    : parsedTitle.nickname;
  const titleLabel = isGenericSubagentTitle(titleWithoutWorkerRole) ? null : titleWithoutWorkerRole;
  const nickname = explicitNickname ?? parsedTitleNickname;
  const role = explicitRole ?? parsedTitleRole;
  const resolvedTitle = parsedTitleNickname ? null : titleLabel;
  const identityLabel = nickname ?? resolvedTitle ?? capitalizeRoleLabel(role);
  const primaryLabel =
    identityLabel ?? normalizeWhitespace(input.placeholderLabel) ?? DEFAULT_SUBAGENT_LABEL;
  const fullLabel = role && nickname ? `${nickname} [${role}]` : primaryLabel;

  return {
    primaryLabel,
    nickname,
    role,
    title: resolvedTitle,
    fullLabel,
  };
}

export function resolveSubagentPresentationForThread(input: {
  thread: Pick<
    SubagentThreadLike,
    "id" | "title" | "parentThreadId" | "subagentAgentId" | "subagentNickname" | "subagentRole"
  >;
  threads?: ReadonlyArray<SubagentThreadLike> | undefined;
}): SubagentPresentation {
  const derivedIdentity =
    input.threads && input.thread.parentThreadId
      ? resolveSubagentIdentityFromParentActivity({
          thread: input.thread,
          threads: input.threads,
        })
      : null;

  const threads = input.threads;
  return resolveSubagentPresentation({
    nickname: input.thread.subagentNickname ?? derivedIdentity?.nickname,
    role: input.thread.subagentRole ?? derivedIdentity?.role,
    title: input.thread.title,
    placeholderLabel:
      derivedIdentity?.promptLabel ??
      (threads ? resolveSubagentSiblingLabel({ thread: input.thread, threads }) : null),
  });
}

export function normalizeSubagentStatusKind(
  status: string | null | undefined,
  isActive = false,
): SubagentStatusKind | null {
  if (isActive) {
    return "running";
  }

  const normalized = status?.trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  if (!normalized || normalized === "unknown") {
    return null;
  }

  if (
    normalized === "running" ||
    normalized === "working" ||
    normalized === "in progress" ||
    normalized === "inprogress" ||
    normalized === "active"
  ) {
    return "running";
  }
  if (
    normalized === "completed" ||
    normalized === "done" ||
    normalized === "finished" ||
    normalized === "success" ||
    normalized === "succeeded"
  ) {
    return "completed";
  }
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "errored" ||
    normalized === "failure"
  ) {
    return "failed";
  }
  if (
    normalized === "stopped" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "interrupted" ||
    normalized === "aborted"
  ) {
    return "stopped";
  }
  if (
    normalized === "queued" ||
    normalized === "pending" ||
    normalized === "waiting" ||
    normalized === "starting"
  ) {
    return "queued";
  }
  if (normalized === "idle") {
    return "idle";
  }

  return null;
}

export function humanizeSubagentStatus(
  status: string | null | undefined,
  isActive = false,
): string | undefined {
  const normalized = normalizeSubagentStatusKind(status, isActive);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "queued":
      return "Queued";
    case "idle":
      return "Idle";
  }
}

// Short form for agent rows: the "Claude " prefix is redundant next to a
// model name ("Haiku 4.5" reads as well as "Claude Haiku 4.5" and halves the
// label), and non-Claude names pass through unchanged.
export function formatSubagentModelLabel(model: string | null | undefined): string | undefined {
  const displayName = formatModelDisplayName(normalizeWhitespace(model));
  return displayName?.startsWith("Claude ") ? displayName.slice("Claude ".length) : displayName;
}

// Status is the only hue in the agent panels: the dot always carries it, the
// text echoes it only while live (running) or when something went wrong
// (failed); terminal/neutral states read as plain muted text. Light themes take
// the darker shade so the text stays readable on a white surface.
export function subagentStatusTextToneClassName(
  statusKind: SubagentStatusKind | null | undefined,
): string {
  switch (statusKind) {
    case "running":
      return "text-sky-600 dark:text-sky-300/85";
    case "failed":
      return "text-rose-600 dark:text-rose-300/85";
    default:
      return "text-muted-foreground/55";
  }
}

// The past-tense outcome word on a finished subagent row ("Done", "Stopped by
// you") also names its state, so it takes the dot's hue in a readable shade.
export function subagentOutcomeTextToneClassName(
  statusKind: SubagentStatusKind | null | undefined,
): string {
  switch (statusKind) {
    case "completed":
      return "text-emerald-700 dark:text-emerald-300/85";
    case "stopped":
      return "text-amber-700 dark:text-amber-300/85";
    default:
      return subagentStatusTextToneClassName(statusKind);
  }
}

interface SubagentThreadStatusSource {
  error?: string | null | undefined;
  session?: { status: string } | null | undefined;
  latestTurn?: { state: string; completedAt?: string | null } | null | undefined;
  hasLiveTailWork?: boolean | undefined;
}

// A child thread's own state, for places that know only the thread (sidebar
// rows, nested subagents): live work wins, then the latest turn's outcome. An
// interrupted turn is a stopped subagent; a thread that never ran has none. A
// "running" turn only counts while the child has a session: Codex children
// have none and their turns never close, so it would read as running forever.
export function resolveSubagentThreadStatusKind(
  thread: SubagentThreadStatusSource,
): SubagentStatusKind | null {
  const sessionStatus = thread.session?.status;
  const latestTurn = thread.latestTurn ?? null;
  if (
    thread.hasLiveTailWork === true ||
    sessionStatus === "running" ||
    (latestTurn?.state === "running" &&
      !latestTurn.completedAt &&
      sessionStatus !== undefined &&
      sessionStatus !== "ready" &&
      sessionStatus !== "closed")
  ) {
    return "running";
  }
  if (sessionStatus === "connecting") {
    return "queued";
  }
  if (thread.error || sessionStatus === "error" || latestTurn?.state === "error") {
    return "failed";
  }
  if (latestTurn?.state === "interrupted") {
    return "stopped";
  }
  if (latestTurn?.state === "completed") {
    return "completed";
  }
  return null;
}

export function subagentStatusDotClassName(
  statusKind: SubagentStatusKind | null | undefined,
): string {
  switch (statusKind) {
    case "running":
      return "bg-sky-300/95";
    case "completed":
      return "bg-emerald-300/80";
    case "failed":
      return "bg-rose-300/90";
    case "stopped":
      return "bg-amber-300/85";
    case "queued":
      return "bg-violet-300/80";
    default:
      return "bg-muted-foreground/25";
  }
}
