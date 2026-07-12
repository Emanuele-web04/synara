// FILE: threadRecap.ts
// Purpose: Build compact, low-churn inputs and browser persistence for AI-generated chat recaps.
// Layer: Client utility
// Exports: recap source derivation plus per-thread localStorage cache helpers.

import type { ThreadId } from "@synara/contracts";
import type { Thread, ChatMessage } from "~/types";
import { isPlainObject, sanitizeStringKeyedRecord } from "~/persistedRecord";

const MAX_RECAP_MESSAGES = 6;
const MAX_DELTA_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 600;
const MAX_ACTIVITY_CHARS = 140;
const MAX_MATERIAL_CHARS = 4_000;
const MAX_STATE_CHARS = 1_500;
const MAX_PERSISTED_RECAPS = 80;
const MAX_PERSISTED_RECAP_TEXT_CHARS = 280;
export const DEFAULT_INITIAL_THREAD_RECAP_IDLE_MS = 12_000;
export const DEFAULT_REFRESH_THREAD_RECAP_IDLE_MS = 35_000;
export const THREAD_RECAP_STORAGE_KEY = "synara:thread-recaps:v1";

interface ThreadRecapStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface ThreadRecapSource {
  readonly hasNewMaterial: boolean;
  readonly latestMessageId: string | null;
  readonly signature: string;
  readonly newMaterial: string;
  readonly currentState: string;
}

export interface DeriveThreadRecapSourceInput {
  readonly thread: Pick<
    Thread,
    | "id"
    | "title"
    | "messages"
    | "activities"
    | "turnDiffSummaries"
    | "latestTurn"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
  >;
  readonly previousCoveredMessageId?: string | null;
  readonly hasPreviousRecap: boolean;
}

export interface PersistedThreadRecap {
  readonly text: string;
  readonly coveredMessageId: string | null;
  readonly sourceSignature: string;
  readonly updatedAt: string;
}

export type PersistedThreadRecapCache = Record<string, PersistedThreadRecap>;

// First recaps should feel responsive; later refreshes wait longer to avoid token churn.
export function resolveThreadRecapIdleMs(input: {
  readonly hasExistingRecap: boolean;
  readonly idleMsOverride?: number | null | undefined;
  readonly initialIdleMsOverride?: number | null | undefined;
  readonly refreshIdleMsOverride?: number | null | undefined;
}): number {
  const defaultIdleMs = input.hasExistingRecap
    ? DEFAULT_REFRESH_THREAD_RECAP_IDLE_MS
    : DEFAULT_INITIAL_THREAD_RECAP_IDLE_MS;
  const scopedOverride = input.hasExistingRecap
    ? input.refreshIdleMsOverride
    : input.initialIdleMsOverride;
  return scopedOverride ?? input.idleMsOverride ?? defaultIdleMs;
}

// Recap generation is an opt-in side effect from the open panel, not a transcript hot-path task.
export function shouldScheduleThreadRecapGeneration(input: {
  readonly cachedSourceSignature?: string | null | undefined;
  readonly cwd: string | null | undefined;
  readonly enabled: boolean;
  readonly failedSourceSignature?: string | null | undefined;
  readonly hasStreamingAssistant: boolean;
  readonly inFlightSourceSignature?: string | null | undefined;
  readonly latestTurnSettled: boolean;
  readonly sourceHasNewMaterial: boolean;
  readonly sourceSignature: string | null | undefined;
  readonly threadId: ThreadId | null | undefined;
}): boolean {
  if (
    !input.enabled ||
    !input.threadId ||
    !input.cwd ||
    !input.sourceHasNewMaterial ||
    !input.sourceSignature ||
    input.hasStreamingAssistant ||
    !input.latestTurnSettled
  ) {
    return false;
  }

  return (
    input.cachedSourceSignature !== input.sourceSignature &&
    input.failedSourceSignature !== input.sourceSignature &&
    input.inFlightSourceSignature !== input.sourceSignature
  );
}

function compactText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/gu, " ").trim();
  if (compacted.length <= maxChars) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxChars - 15)).trimEnd()}... [truncated]`;
}

function isRecappableMessage(message: ChatMessage): boolean {
  return (
    (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0
  );
}

function formatMessageForRecap(message: ChatMessage): string {
  const text = compactText(message.text, MAX_MESSAGE_CHARS);
  const attachmentSummary =
    message.attachments && message.attachments.length > 0
      ? ` Attachments: ${message.attachments
          .map((attachment) => {
            if (attachment.type === "image" || attachment.type === "file") {
              return attachment.name;
            }
            return "assistant selection";
          })
          .join(", ")}.`
      : "";
  return `[${message.role}] ${text}${attachmentSummary}`;
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n[truncated]`;
}

function getThreadRecapStorage(): ThreadRecapStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sanitizePersistedRecapText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const compacted = compactText(value, MAX_PERSISTED_RECAP_TEXT_CHARS);
  return compacted.length > 0 ? compacted : null;
}

function sanitizePersistedThreadRecap(rawEntry: unknown): PersistedThreadRecap | null {
  if (!isPlainObject(rawEntry)) {
    return null;
  }

  const text = sanitizePersistedRecapText(rawEntry.text);
  const sourceSignature =
    typeof rawEntry.sourceSignature === "string" ? rawEntry.sourceSignature.trim() : "";
  const updatedAt = typeof rawEntry.updatedAt === "string" ? rawEntry.updatedAt.trim() : "";
  const coveredMessageId =
    typeof rawEntry.coveredMessageId === "string" && rawEntry.coveredMessageId.length > 0
      ? rawEntry.coveredMessageId
      : null;

  if (!text || sourceSignature.length === 0 || updatedAt.length === 0) {
    return null;
  }

  return {
    text,
    coveredMessageId,
    sourceSignature,
    updatedAt,
  };
}

// Keeps localStorage bounded while preserving the freshest thread memories.
export function prunePersistedThreadRecapCache(
  cache: PersistedThreadRecapCache,
): PersistedThreadRecapCache {
  return Object.fromEntries(
    Object.entries(cache)
      .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_PERSISTED_RECAPS),
  );
}

export function upsertPersistedThreadRecap(
  cache: PersistedThreadRecapCache,
  threadId: ThreadId,
  recap: PersistedThreadRecap,
): PersistedThreadRecapCache {
  return prunePersistedThreadRecapCache({
    ...cache,
    [threadId]: recap,
  });
}

export function readPersistedThreadRecapCache(
  storage: ThreadRecapStorage | null = getThreadRecapStorage(),
): PersistedThreadRecapCache {
  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(THREAD_RECAP_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    return prunePersistedThreadRecapCache(
      sanitizeStringKeyedRecord(JSON.parse(raw) as unknown, sanitizePersistedThreadRecap),
    );
  } catch {
    return {};
  }
}

export function persistThreadRecapCache(
  cache: PersistedThreadRecapCache,
  storage: ThreadRecapStorage | null = getThreadRecapStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    const prunedCache = prunePersistedThreadRecapCache(cache);
    if (Object.keys(prunedCache).length === 0) {
      storage.removeItem(THREAD_RECAP_STORAGE_KEY);
      return;
    }
    storage.setItem(THREAD_RECAP_STORAGE_KEY, JSON.stringify(prunedCache));
  } catch {
    // Best-effort cache only; quota or disabled-storage failures must not affect chat.
  }
}

function buildNewMaterial(input: {
  readonly threadTitle: string;
  readonly messages: readonly ChatMessage[];
}): string {
  const lines = [
    `Thread: ${input.threadTitle}`,
    ...input.messages.map((message) => formatMessageForRecap(message)),
  ];
  return limitSection(lines.join("\n"), MAX_MATERIAL_CHARS);
}

function buildCurrentState(thread: DeriveThreadRecapSourceInput["thread"]): string {
  const stateLines: string[] = [];
  if (thread.latestTurn) {
    stateLines.push(`Latest turn: ${thread.latestTurn.state}`);
  }
  if (thread.hasPendingApprovals) {
    stateLines.push("Pending: approval required");
  }
  if (thread.hasPendingUserInput) {
    stateLines.push("Pending: user input required");
  }
  if (thread.hasActionableProposedPlan) {
    stateLines.push("Pending: actionable proposed plan");
  }

  const recentActivities: string[] = [];
  for (
    let index = thread.activities.length - 1;
    index >= 0 && recentActivities.length < 4;
    index--
  ) {
    const activity = thread.activities[index];
    if (!activity || (activity.tone === "tool" && activity.summary.trim().length === 0)) {
      continue;
    }
    recentActivities.push(`${activity.kind}: ${compactText(activity.summary, MAX_ACTIVITY_CHARS)}`);
  }
  recentActivities.reverse();
  if (recentActivities.length > 0) {
    stateLines.push(`Recent activity: ${recentActivities.join(" | ")}`);
  }

  const latestDiffSummary = thread.turnDiffSummaries.at(-1);
  if (latestDiffSummary && latestDiffSummary.files.length > 0) {
    const changedFiles = latestDiffSummary.files
      .slice(0, 5)
      .map((file) => file.path)
      .join(", ");
    stateLines.push(`Latest changed files: ${changedFiles}`);
  }

  return limitSection(stateLines.join("\n"), MAX_STATE_CHARS);
}

function messageSignature(message: ChatMessage): string {
  return [
    message.id,
    message.role,
    message.text.length,
    message.completedAt ?? "",
    message.streaming ? "streaming" : "settled",
  ].join(":");
}

// Selects only real transcript messages so tool/work activity cannot trigger recap churn.
export function deriveThreadRecapSource(input: DeriveThreadRecapSourceInput): ThreadRecapSource {
  const recappableMessages = input.thread.messages.filter(isRecappableMessage);
  const latestMessage = recappableMessages.at(-1) ?? null;
  const latestMessageId = latestMessage?.id ?? null;
  const coveredIndex = input.previousCoveredMessageId
    ? recappableMessages.findIndex((message) => message.id === input.previousCoveredMessageId)
    : -1;
  const deltaMessages =
    coveredIndex >= 0 ? recappableMessages.slice(coveredIndex + 1) : recappableMessages;
  const selectedMessages = input.hasPreviousRecap
    ? deltaMessages.slice(-MAX_DELTA_MESSAGES)
    : recappableMessages.slice(-MAX_RECAP_MESSAGES);
  const hasNewMaterial =
    selectedMessages.length > 0 && coveredIndex < recappableMessages.length - 1;
  const signature = [
    input.thread.id,
    latestMessage ? messageSignature(latestMessage) : "empty",
    input.thread.latestTurn?.state ?? "no-turn",
    input.thread.hasPendingApprovals ? "approval" : "",
    input.thread.hasPendingUserInput ? "input" : "",
    input.thread.hasActionableProposedPlan ? "plan" : "",
  ].join("|");

  return {
    hasNewMaterial,
    latestMessageId,
    signature,
    newMaterial: buildNewMaterial({
      threadTitle: input.thread.title,
      messages: selectedMessages,
    }),
    currentState: buildCurrentState(input.thread),
  };
}
