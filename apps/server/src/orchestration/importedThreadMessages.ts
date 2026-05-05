import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageId, type ThreadHandoffImportedMessage, type ThreadId } from "@t3tools/contracts";

function readTranscriptTextParts(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as {
      readonly type?: unknown;
      readonly text?: unknown;
    };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

function readCodexSnapshotMessageText(value: unknown): string {
  if (!value || typeof value !== "object") return "";

  const candidate = value as {
    readonly text?: unknown;
    readonly content?: unknown;
  };
  if (typeof candidate.text === "string") return candidate.text;

  return readTranscriptTextParts(candidate.content).join("");
}

export function mapCodexSnapshotMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{
    readonly items: ReadonlyArray<unknown>;
  }>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  return input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex) => {
      if (!item || typeof item !== "object") return [];

      const candidate = item as {
        readonly type?: unknown;
        readonly content?: unknown;
      };
      const role =
        candidate.type === "userMessage"
          ? "user"
          : candidate.type === "agentMessage"
            ? "assistant"
            : null;
      if (role === null) return [];

      const text = readCodexSnapshotMessageText(candidate);
      if (text.length === 0) return [];

      return [
        {
          messageId: MessageId.makeUnsafe(
            `import:${String(input.threadId)}:${turnIndex}:${itemIndex}`,
          ),
          role,
          text,
          createdAt: input.importedAt,
          updatedAt: input.importedAt,
        },
      ];
    }),
  );
}

function readClaudeSessionMessageText(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";

  const candidate = value as {
    readonly content?: unknown;
    readonly text?: unknown;
  };
  if (typeof candidate.text === "string") return candidate.text;
  if (typeof candidate.content === "string") return candidate.content;

  return readTranscriptTextParts(candidate.content).join("\n\n");
}

export function mapClaudeSessionMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ClaudeSessionMessage>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  return input.messages.flatMap((message, messageIndex) => {
    if (message.type !== "user" && message.type !== "assistant") return [];

    const text = readClaudeSessionMessageText(message.message).trim();
    if (text.length === 0) return [];

    return [
      {
        messageId: MessageId.makeUnsafe(
          `import:${String(input.threadId)}:claude:${messageIndex}:${message.uuid}`,
        ),
        role: message.type,
        text,
        createdAt: input.importedAt,
        updatedAt: input.importedAt,
      },
    ];
  });
}

function readOpenCodeSessionMessageText(parts: ReadonlyArray<unknown>): string {
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as {
        readonly type?: unknown;
        readonly text?: unknown;
      };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("\n\n")
    .trim();
}

export function mapOpenCodeSnapshotMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{
    readonly items: ReadonlyArray<unknown>;
  }>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  return input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex) => {
      if (!item || typeof item !== "object") return [];

      const candidate = item as {
        readonly info?: {
          readonly id?: unknown;
          readonly role?: unknown;
        };
        readonly parts?: ReadonlyArray<unknown>;
      };
      const role =
        candidate.info?.role === "user"
          ? "user"
          : candidate.info?.role === "assistant"
            ? "assistant"
            : null;
      if (role === null) return [];

      const text = readOpenCodeSessionMessageText(candidate.parts ?? []);
      if (text.length === 0) return [];

      const sourceId =
        typeof candidate.info?.id === "string" && candidate.info.id.length > 0
          ? candidate.info.id
          : `${turnIndex}:${itemIndex}`;

      return [
        {
          messageId: MessageId.makeUnsafe(
            `import:${String(input.threadId)}:opencode:${turnIndex}:${itemIndex}:${sourceId}`,
          ),
          role,
          text,
          createdAt: input.importedAt,
          updatedAt: input.importedAt,
        },
      ];
    }),
  );
}
