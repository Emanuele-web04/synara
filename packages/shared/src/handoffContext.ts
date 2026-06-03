// FILE: handoffContext.ts
// Purpose: Shared builders for provider handoff, sidechat, and transcript bootstrap context.
// Layer: Shared runtime utilities
// Depends on: orchestration contracts

import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ProviderKind,
} from "@t3tools/contracts";

const RECENT_MESSAGE_COUNT = 6;
const EARLIER_MESSAGE_CHAR_LIMIT = 320;
const RECENT_MESSAGE_CHAR_LIMIT = 2_400;
const HANDOFF_BOOTSTRAP_CHAR_BUDGET = Math.floor(PROVIDER_SEND_TURN_MAX_INPUT_CHARS * 0.75);

export const HANDOFF_CONTEXT_WRAPPER =
  "<handoff_context>\n\n</handoff_context>\n\n<latest_user_message>\n\n</latest_user_message>";
export const HANDOFF_CONTEXT_WRAPPER_OVERHEAD = HANDOFF_CONTEXT_WRAPPER.length;

type BootstrapThreadMetadata = Pick<OrchestrationThread, "title" | "branch" | "worktreePath">;
type BootstrapMessage = Pick<OrchestrationMessage, "role" | "source" | "streaming" | "text">;
type ImportedBootstrapMessage = Pick<OrchestrationMessage, "role" | "text">;

function normalizeMessageText(value: string): string {
  return value
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function roleLabel(message: Pick<OrchestrationMessage, "role">): "User" | "Assistant" {
  return message.role === "assistant" ? "Assistant" : "User";
}

export function calculateAvailableHandoffBootstrapChars(latestUserMessageText: string): number {
  return Math.max(
    0,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
      latestUserMessageText.length -
      HANDOFF_CONTEXT_WRAPPER_OVERHEAD,
  );
}

export function listImportedHandoffMessages(input: {
  readonly messages: ReadonlyArray<BootstrapMessage>;
}): ReadonlyArray<BootstrapMessage> {
  return input.messages.filter(
    (message) =>
      message.source === "handoff-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function listImportedForkMessages(input: {
  readonly messages: ReadonlyArray<BootstrapMessage>;
}): ReadonlyArray<BootstrapMessage> {
  return input.messages.filter(
    (message) =>
      message.source === "fork-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function hasNativeHandoffMessages(input: {
  readonly messages: ReadonlyArray<BootstrapMessage>;
}): boolean {
  return input.messages.some(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.source === "native" &&
      message.streaming === false,
  );
}

export function hasNativeAssistantMessagesBefore(
  input: {
    readonly messages: ReadonlyArray<BootstrapMessage & { id?: string }>;
  },
  currentMessageId: string,
): boolean {
  const currentIndex = input.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return false;
  }
  return input.messages.slice(0, currentIndex).some((message) => {
    return (
      message.role === "assistant" && message.source === "native" && message.streaming === false
    );
  });
}

export function listPriorTranscriptMessages(
  input: {
    readonly messages: ReadonlyArray<BootstrapMessage & { id?: string }>;
  },
  currentMessageId: string,
): ReadonlyArray<BootstrapMessage> {
  const currentIndex = input.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return [];
  }

  return input.messages.slice(0, currentIndex).filter((message) => {
    return (
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false &&
      normalizeMessageText(message.text).length > 0
    );
  });
}

function buildImportedMessagesBootstrapText(input: {
  thread: BootstrapThreadMetadata;
  importedMessages: ReadonlyArray<ImportedBootstrapMessage>;
  intro: string;
  maxChars: number;
}): string | null {
  if (input.importedMessages.length === 0) {
    return null;
  }

  const earlierMessages = input.importedMessages.slice(0, -RECENT_MESSAGE_COUNT);
  const recentMessages = input.importedMessages.slice(-RECENT_MESSAGE_COUNT);
  const sections: string[] = [input.intro, `Original conversation title: ${input.thread.title}`];

  if (input.thread.branch) {
    sections.push(`Git branch: ${input.thread.branch}`);
  }
  if (input.thread.worktreePath) {
    sections.push(`Worktree path: ${input.thread.worktreePath}`);
  }

  if (earlierMessages.length > 0) {
    sections.push(
      "Earlier conversation summary:\n" +
        earlierMessages
          .map((message) => {
            const normalized = truncateText(
              normalizeMessageText(message.text),
              EARLIER_MESSAGE_CHAR_LIMIT,
            );
            return `- ${roleLabel(message)}: ${normalized}`;
          })
          .join("\n"),
    );
  }

  sections.push(
    "Most recent imported messages:\n" +
      recentMessages
        .map((message) => {
          const normalized = truncateText(
            normalizeMessageText(message.text),
            RECENT_MESSAGE_CHAR_LIMIT,
          );
          return `${roleLabel(message)}:\n${normalized}`;
        })
        .join("\n\n"),
  );

  const joined = sections.join("\n\n").trim();
  return truncateText(joined, Math.max(0, input.maxChars));
}

export function buildHandoffBootstrapTextFromImportedMessages(input: {
  thread: BootstrapThreadMetadata;
  importedMessages: ReadonlyArray<ImportedBootstrapMessage>;
  sourceProvider: ProviderKind;
  maxChars?: number;
}): string | null {
  return buildImportedMessagesBootstrapText({
    thread: input.thread,
    importedMessages: input.importedMessages,
    intro: `This conversation was handed off from ${input.sourceProvider}.`,
    maxChars: input.maxChars ?? HANDOFF_BOOTSTRAP_CHAR_BUDGET,
  });
}

export function buildHandoffBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "handoff" | "messages">,
  maxChars = HANDOFF_BOOTSTRAP_CHAR_BUDGET,
): string | null {
  const importedMessages = listImportedHandoffMessages(thread);
  if (importedMessages.length === 0 || thread.handoff === null) {
    return null;
  }

  return buildHandoffBootstrapTextFromImportedMessages({
    thread,
    importedMessages,
    sourceProvider: thread.handoff.sourceProvider,
    maxChars,
  });
}

export function buildPriorTranscriptBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  currentMessageId: string,
  maxChars = HANDOFF_BOOTSTRAP_CHAR_BUDGET,
): string | null {
  const priorMessages = listPriorTranscriptMessages(thread, currentMessageId);
  if (priorMessages.length === 0) {
    return null;
  }

  return buildImportedMessagesBootstrapText({
    thread,
    importedMessages: priorMessages,
    intro:
      "This provider session may have been restarted without native conversation state. Use this prior Synara transcript as context for the latest user message.",
    maxChars,
  });
}

export function buildForkBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  maxChars = HANDOFF_BOOTSTRAP_CHAR_BUDGET,
): string | null {
  const importedMessages = listImportedForkMessages(thread);
  if (importedMessages.length === 0) {
    return null;
  }

  return buildImportedMessagesBootstrapText({
    thread,
    importedMessages,
    intro: "This sidechat was cloned from an earlier conversation.",
    maxChars,
  });
}
