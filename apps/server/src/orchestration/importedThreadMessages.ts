// FILE: importedThreadMessages.ts
// Purpose: Normalizes provider-native transcript snapshots into Synara import messages.
// Layer: Orchestration import mapping
// Exports: Codex, Claude, OpenCode, and Factory Droid transcript mappers.

import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageId, type ThreadHandoffImportedMessage, type ThreadId } from "@synara/contracts";

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

interface CodexImportTurn {
  readonly id?: string;
  readonly startedAt?: unknown;
  readonly completedAt?: unknown;
  readonly items: ReadonlyArray<unknown>;
}

type ClaudeImportMessage = ClaudeSessionMessage & {
  // The SDK omits timestamps; the import reader can recover these by UUID from JSONL.
  readonly timestamp?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
};

interface PendingImportMessage {
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number | undefined;
  readonly updatedAt: number | undefined;
}

function readTimestamp(value: unknown): number | undefined {
  // Codex turn times are Unix seconds; enriched local records may use milliseconds.
  const milliseconds =
    typeof value === "number"
      ? Math.abs(value) < 1e12
        ? value * 1_000
        : value
      : typeof value === "string" && value.trim().length > 0
        ? Date.parse(value)
        : Number.NaN;
  const timestamp = new Date(milliseconds).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function finalizeImportedMessages(
  messages: ReadonlyArray<PendingImportMessage>,
  importedAt: string,
): ReadonlyArray<ThreadHandoffImportedMessage> {
  const firstDatedIndex = messages.findIndex((message) => message.createdAt !== undefined);
  const firstDatedMessage = messages[firstDatedIndex];
  let previousTimestamp =
    firstDatedMessage?.createdAt !== undefined
      ? firstDatedMessage.createdAt - firstDatedIndex - 1
      : Date.parse(importedAt) - 1;

  return messages.map((message) => {
    // Projections sort by timestamp and ID. Distinct milliseconds preserve source order
    // when native records have absent/equal times, without depending on UUID ordering.
    const createdAt = Math.max(message.createdAt ?? previousTimestamp + 1, previousTimestamp + 1);
    previousTimestamp = createdAt;
    return {
      messageId: message.messageId,
      role: message.role,
      text: message.text,
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(Math.max(createdAt, message.updatedAt ?? createdAt)).toISOString(),
    };
  });
}

export function mapCodexSnapshotMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<CodexImportTurn>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  const messages = input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex): ReadonlyArray<PendingImportMessage> => {
      if (!item || typeof item !== "object") return [];

      const candidate = item as {
        readonly id?: unknown;
        readonly type?: unknown;
        readonly content?: unknown;
        readonly createdAt?: unknown;
        readonly updatedAt?: unknown;
        readonly timestamp?: unknown;
      };
      const role =
        candidate.type === "userMessage"
          ? "user"
          : candidate.type === "agentMessage"
            ? "assistant"
            : null;
      if (role === null) return [];

      const text = readCodexSnapshotMessageText(candidate);
      if (text.trim().length === 0) return [];
      const sourceId =
        typeof candidate.id === "string" && candidate.id.length > 0
          ? candidate.id
          : `${turn.id ?? turnIndex}:${itemIndex}`;
      const turnTimestamp =
        (role === "assistant" ? readTimestamp(turn.completedAt) : undefined) ??
        readTimestamp(turn.startedAt);

      return [
        {
          messageId: MessageId.makeUnsafe(`import:${String(input.threadId)}:codex:${sourceId}`),
          role,
          text,
          createdAt:
            readTimestamp(candidate.createdAt) ??
            readTimestamp(candidate.timestamp) ??
            turnTimestamp,
          updatedAt: readTimestamp(candidate.updatedAt),
        },
      ];
    }),
  );
  return finalizeImportedMessages(messages, input.importedAt);
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
  readonly messages: ReadonlyArray<ClaudeImportMessage>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  const messages = input.messages.flatMap(
    (message, messageIndex): ReadonlyArray<PendingImportMessage> => {
      if (message.type !== "user" && message.type !== "assistant") return [];

      const text = readClaudeSessionMessageText(message.message);
      if (text.trim().length === 0) return [];
      const sourceId = message.uuid.length > 0 ? message.uuid : String(messageIndex);

      return [
        {
          messageId: MessageId.makeUnsafe(`import:${String(input.threadId)}:claude:${sourceId}`),
          role: message.type,
          text,
          createdAt: readTimestamp(message.timestamp) ?? readTimestamp(message.createdAt),
          updatedAt: readTimestamp(message.updatedAt),
        },
      ];
    },
  );
  return finalizeImportedMessages(messages, input.importedAt);
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

export function mapFactorySnapshotMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  let messageIndex = 0;
  return input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as {
        readonly type?: unknown;
        readonly id?: unknown;
        readonly role?: unknown;
        readonly text?: unknown;
        readonly timestamp?: unknown;
      };
      if (candidate.type !== "factoryMessage") return [];
      const role =
        candidate.role === "user" ? "user" : candidate.role === "assistant" ? "assistant" : null;
      const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
      if (!role || !text) return [];
      const sourceId =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : `${turnIndex}:${itemIndex}`;
      const parsedTimestamp =
        typeof candidate.timestamp === "string" ? Date.parse(candidate.timestamp) : Number.NaN;
      const fallbackTimestamp = Date.parse(input.importedAt) + messageIndex;
      const createdAt = new Date(
        Number.isFinite(parsedTimestamp) ? parsedTimestamp : fallbackTimestamp,
      ).toISOString();
      messageIndex += 1;
      return [
        {
          messageId: MessageId.makeUnsafe(
            `import:${String(input.threadId)}:droid:${turnIndex}:${itemIndex}:${sourceId}`,
          ),
          role,
          text,
          createdAt,
          updatedAt: createdAt,
        },
      ];
    }),
  );
}

export function mapOmpSnapshotMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  let messageIndex = 0;
  return input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as {
        readonly type?: unknown;
        readonly id?: unknown;
        readonly role?: unknown;
        readonly text?: unknown;
        readonly timestamp?: unknown;
      };
      if (candidate.type !== "ompMessage") return [];
      const role =
        candidate.role === "user" ? "user" : candidate.role === "assistant" ? "assistant" : null;
      const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
      if (!role || !text) return [];
      const sourceId =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : `${turnIndex}:${itemIndex}`;
      const parsedTimestamp =
        typeof candidate.timestamp === "string" ? Date.parse(candidate.timestamp) : Number.NaN;
      const fallbackTimestamp = Date.parse(input.importedAt) + messageIndex;
      const createdAt = new Date(
        Number.isFinite(parsedTimestamp) ? parsedTimestamp : fallbackTimestamp,
      ).toISOString();
      messageIndex += 1;
      return [
        {
          messageId: MessageId.makeUnsafe(
            `import:${String(input.threadId)}:omp:${turnIndex}:${itemIndex}:${sourceId}`,
          ),
          role,
          text,
          createdAt,
          updatedAt: createdAt,
        },
      ];
    }),
  );
}
