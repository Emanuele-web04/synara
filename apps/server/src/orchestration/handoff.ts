import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";

const RECENT_MESSAGE_COUNT = 6;
const EARLIER_MESSAGE_CHAR_LIMIT = 320;
const RECENT_MESSAGE_CHAR_LIMIT = 2_400;
const HANDOFF_BOOTSTRAP_CHAR_BUDGET = Math.floor(PROVIDER_SEND_TURN_MAX_INPUT_CHARS * 0.75);

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

export function listImportedHandoffMessages(
  thread: Pick<OrchestrationThread, "messages">,
): ReadonlyArray<OrchestrationMessage> {
  return thread.messages.filter(
    (message) =>
      message.source === "handoff-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function hasNativeHandoffMessages(thread: Pick<OrchestrationThread, "messages">): boolean {
  return thread.messages.some(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.source === "native" &&
      message.streaming === false,
  );
}

export function hasNativeAssistantMessagesBefore(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId: string,
): boolean {
  const currentIndex = thread.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return false;
  }
  return thread.messages.slice(0, currentIndex).some((message) => {
    return (
      message.role === "assistant" && message.source === "native" && message.streaming === false
    );
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

  const earlierMessages = importedMessages.slice(0, -RECENT_MESSAGE_COUNT);
  const recentMessages = importedMessages.slice(-RECENT_MESSAGE_COUNT);
  const sections: string[] = [
    `This conversation was handed off from ${thread.handoff.sourceProvider}.`,
    `Original conversation title: ${thread.title}`,
  ];

  if (thread.branch) {
    sections.push(`Git branch: ${thread.branch}`);
  }
  if (thread.worktreePath) {
    sections.push(`Worktree path: ${thread.worktreePath}`);
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
  return truncateText(joined, Math.max(0, maxChars));
}
