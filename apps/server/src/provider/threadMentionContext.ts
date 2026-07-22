// FILE: threadMentionContext.ts
// Purpose: Resolve thread:// composer references into bounded transcript prompt context.
// Layer: Provider prompt compatibility

import {
  ThreadId,
  type OrchestrationThread,
  type ProviderMentionReference,
} from "@synara/contracts";
import { isThreadMentionPath, threadIdFromThreadMentionPath } from "@synara/shared/threadMentions";
import { Effect, Option } from "effect";

import { paginateThreadMessages } from "../agentGateway/threadSummary.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const THREAD_MENTION_MESSAGE_LIMIT = 20;
export const THREAD_MENTION_MAX_MESSAGE_CHARS = 1_500;
export const THREAD_MENTION_MAX_CONTEXT_CHARS = 8_000;
export const THREAD_MENTION_MAX_TOTAL_CONTEXT_CHARS = 16_000;
export const THREAD_MENTION_MAX_TITLE_CHARS = 200;

const EARLIER_CONTEXT_TRUNCATION_MARKER = "[... earlier transcript context truncated]\n";
const THREAD_MENTION_MIN_CONTEXT_CHARS = 256;
const THREAD_MENTION_CONTEXT_SEPARATOR_CHARS = 2;
const THREAD_MENTION_CONTEXT_CLOSE_TAG = "</mentioned_thread_context>";
const THREAD_MENTION_BLOCK_TRUNCATION_MARKER = "\n[... context block truncated]\n";

export function isThreadMentionReference(reference: ProviderMentionReference): boolean {
  return isThreadMentionPath(reference.path);
}

export function threadIdFromMentionReference(reference: ProviderMentionReference): string | null {
  return threadIdFromThreadMentionPath(reference.path);
}

function clampMentionTitle(title: string): string {
  return title.length > THREAD_MENTION_MAX_TITLE_CHARS
    ? `${title.slice(0, THREAD_MENTION_MAX_TITLE_CHARS - 1)}…`
    : title;
}

function truncateTranscriptTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= EARLIER_CONTEXT_TRUNCATION_MARKER.length) {
    return EARLIER_CONTEXT_TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${EARLIER_CONTEXT_TRUNCATION_MARKER}${text.slice(
    -(maxChars - EARLIER_CONTEXT_TRUNCATION_MARKER.length),
  )}`;
}

function fitContextBlockToMaxChars(block: string, maxChars: number): string {
  if (block.length <= maxChars) return block;
  const availablePrefixChars =
    maxChars -
    THREAD_MENTION_BLOCK_TRUNCATION_MARKER.length -
    THREAD_MENTION_CONTEXT_CLOSE_TAG.length;
  if (availablePrefixChars <= 0) return "";
  const prefix = block.slice(0, availablePrefixChars).trimEnd();
  return `${prefix}${THREAD_MENTION_BLOCK_TRUNCATION_MARKER}${THREAD_MENTION_CONTEXT_CLOSE_TAG}`;
}

export function formatThreadMentionContextBlock(input: {
  readonly reference: ProviderMentionReference;
  readonly thread: OrchestrationThread | null;
  readonly maxChars?: number;
}): string {
  const threadId = threadIdFromMentionReference(input.reference) ?? input.reference.path;
  const maxChars = Math.max(0, Math.floor(input.maxChars ?? THREAD_MENTION_MAX_CONTEXT_CHARS));
  if (maxChars === 0) return "";
  if (!input.thread) {
    return fitContextBlockToMaxChars(
      [
        "<mentioned_thread_context>",
        `Referenced chat ${JSON.stringify(clampMentionTitle(input.reference.name))} (thread id: ${threadId}) could not be found.`,
        THREAD_MENTION_CONTEXT_CLOSE_TAG,
      ].join("\n"),
      maxChars,
    );
  }

  const page = paginateThreadMessages({
    messages: input.thread.messages,
    messageLimit: THREAD_MENTION_MESSAGE_LIMIT,
    maxMessageChars: THREAD_MENTION_MAX_MESSAGE_CHARS,
  });
  const title = clampMentionTitle(
    input.thread.title.trim() || input.reference.name || "Untitled thread",
  );
  const header = [
    "<mentioned_thread_context>",
    `Thread: ${JSON.stringify(title)}`,
    `Provider: ${input.thread.modelSelection.provider}`,
    `Thread ID: ${threadId}`,
    "Recent transcript (newest last):",
  ].join("\n");
  const footer = THREAD_MENTION_CONTEXT_CLOSE_TAG;
  const transcript = [
    ...(page.nextCursor !== undefined ? [`[... ${page.nextCursor} older messages omitted]`] : []),
    ...page.messages.map((message) => `[${message.role}]\n${message.text}`),
  ].join("\n\n");
  const availableTranscriptChars = Math.max(0, maxChars - header.length - footer.length - 2);
  const boundedTranscript = truncateTranscriptTail(transcript, availableTranscriptChars);
  return fitContextBlockToMaxChars(`${header}\n${boundedTranscript}\n${footer}`, maxChars);
}

export interface ResolvedThreadMentionPromptProjection {
  readonly contextBlocks: readonly string[];
  readonly providerMentions: ReadonlyArray<ProviderMentionReference> | undefined;
}

export function resolveThreadMentionPromptProjection(input: {
  readonly mentions: ReadonlyArray<ProviderMentionReference> | undefined;
  readonly snapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadDetailById">;
  readonly maxTotalContextChars?: number;
}): Effect.Effect<ResolvedThreadMentionPromptProjection> {
  const threadMentions = (input.mentions ?? []).filter(isThreadMentionReference);
  const providerMentions = (input.mentions ?? []).filter(
    (reference) => !isThreadMentionReference(reference),
  );
  const maxTotalContextChars = Math.min(
    THREAD_MENTION_MAX_TOTAL_CONTEXT_CHARS,
    Math.max(0, Math.floor(input.maxTotalContextChars ?? THREAD_MENTION_MAX_TOTAL_CONTEXT_CHARS)),
  );
  const maxResolvedMentionCount = Math.floor(
    (maxTotalContextChars + THREAD_MENTION_CONTEXT_SEPARATOR_CHARS) /
      (THREAD_MENTION_MIN_CONTEXT_CHARS + THREAD_MENTION_CONTEXT_SEPARATOR_CHARS),
  );
  // A minimum useful block size also bounds projection reads: callers cannot
  // submit an unbounded references array and make the server hydrate every thread.
  const contextMentions = threadMentions.slice(0, maxResolvedMentionCount);
  if (contextMentions.length === 0) {
    return Effect.succeed({
      contextBlocks: [],
      providerMentions: providerMentions.length > 0 ? providerMentions : undefined,
    });
  }

  const perThreadMaxChars = Math.min(
    THREAD_MENTION_MAX_CONTEXT_CHARS,
    Math.floor(
      (maxTotalContextChars -
        Math.max(0, contextMentions.length - 1) * THREAD_MENTION_CONTEXT_SEPARATOR_CHARS) /
        contextMentions.length,
    ),
  );
  return Effect.forEach(contextMentions, (reference) => {
    const threadId = threadIdFromMentionReference(reference);
    const thread = threadId
      ? input.snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(threadId)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to resolve mentioned thread context", {
              threadId,
              error,
            }).pipe(Effect.as(Option.none<OrchestrationThread>())),
          ),
          Effect.map(Option.getOrNull),
        )
      : Effect.succeed(null);
    return thread.pipe(
      Effect.map((resolvedThread) =>
        formatThreadMentionContextBlock({
          reference,
          thread: resolvedThread,
          maxChars: perThreadMaxChars,
        }),
      ),
    );
  }).pipe(
    Effect.map((contextBlocks) => ({
      contextBlocks,
      providerMentions: providerMentions.length > 0 ? providerMentions : undefined,
    })),
  );
}

/**
 * Suffix appended after the provider input so mentioned-thread context never
 * lands inside `<latest_user_message>` wrappers. Empty when nothing resolved.
 */
export function threadMentionContextSuffix(contextBlocks: readonly string[]): string {
  return contextBlocks.length > 0 ? `\n\n${contextBlocks.join("\n\n")}` : "";
}

export function appendThreadMentionContextBlocks(input: {
  readonly text: string;
  readonly contextBlocks: readonly string[];
}): string {
  return `${input.text}${threadMentionContextSuffix(input.contextBlocks)}`;
}
