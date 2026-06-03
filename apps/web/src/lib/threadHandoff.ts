// FILE: threadHandoff.ts
// Purpose: Builds client-side handoff commands and imported transcript payloads.
// Layer: Web handoff utilities
// Exports: target-provider, title, transcript, and model-selection helpers.

import {
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderKind,
  type ThreadId,
  type ThreadHandoffImportedMessage,
} from "@t3tools/contracts";
import {
  buildHandoffBootstrapTextFromImportedMessages,
  calculateAvailableHandoffBootstrapChars,
} from "@t3tools/shared/handoffContext";
import { getDefaultModel } from "@t3tools/shared/model";
import { type Thread } from "../types";
import { stripEmbeddedAssistantSelections } from "./assistantSelections";
import { randomUUID } from "./utils";

export interface ThreadHandoffLink {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly provider: ProviderKind;
  readonly sourceThreadId: ThreadId;
  readonly sourceProvider: ProviderKind;
  readonly importedAt: string;
}

const HANDOFF_PROVIDER_ORDER: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
];
const IMPORTABLE_THREAD_ACTIVITY_KINDS = new Set([
  "account.rate-limits.updated",
  "account.rate-limited",
  "context-window.updated",
  "context-window.configured",
]);

function isImportableThreadMessage(
  message: Thread["messages"][number],
): message is Thread["messages"][number] & {
  role: "user" | "assistant";
} {
  return (message.role === "user" || message.role === "assistant") && message.streaming === false;
}

function isImportableThreadActivity(
  activity: Thread["activities"][number],
): activity is OrchestrationThreadActivity {
  return IMPORTABLE_THREAD_ACTIVITY_KINDS.has(activity.kind);
}

export function resolveAvailableHandoffTargetProviders(
  sourceProvider: ProviderKind,
): ReadonlyArray<ProviderKind> {
  return HANDOFF_PROVIDER_ORDER.filter((provider) => provider !== sourceProvider);
}

export function resolveThreadHandoffBadgeLabel(thread: Pick<Thread, "handoff">): string | null {
  if (!thread.handoff) {
    return null;
  }
  return `Continued from ${PROVIDER_DISPLAY_NAMES[thread.handoff.sourceProvider]}`;
}

export function resolveThreadOutgoingHandoffLabel(
  link: Pick<ThreadHandoffLink, "provider">,
): string {
  return `Continued with ${PROVIDER_DISPLAY_NAMES[link.provider]}`;
}

export function resolveThreadOutgoingHandoffTooltip(
  link: Pick<ThreadHandoffLink, "provider">,
  additionalCount = 0,
): string {
  const label = resolveThreadOutgoingHandoffLabel(link);
  if (additionalCount <= 0) {
    return label;
  }
  return `${label}; ${additionalCount} more continuation${additionalCount === 1 ? "" : "s"}`;
}

export function buildOutgoingThreadHandoffLinks<
  T extends Pick<Thread, "id" | "projectId" | "title" | "modelSelection" | "handoff"> & {
    readonly archivedAt?: string | null;
  },
>(input: {
  readonly sourceThread: Pick<Thread, "id" | "projectId">;
  readonly threads: readonly T[];
}): readonly ThreadHandoffLink[] {
  return input.threads
    .flatMap((thread): ThreadHandoffLink[] => {
      if (
        thread.id === input.sourceThread.id ||
        thread.projectId !== input.sourceThread.projectId ||
        thread.archivedAt ||
        !thread.handoff ||
        thread.handoff.sourceThreadId !== input.sourceThread.id
      ) {
        return [];
      }
      return [
        {
          threadId: thread.id,
          title: thread.title,
          provider: thread.modelSelection.provider,
          sourceThreadId: thread.handoff.sourceThreadId,
          sourceProvider: thread.handoff.sourceProvider,
          importedAt: thread.handoff.importedAt,
        },
      ];
    })
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt));
}

export function resolvePrimaryOutgoingThreadHandoffLink(
  links: readonly ThreadHandoffLink[],
): ThreadHandoffLink | null {
  return links[0] ?? null;
}

// Preserve the visible source thread name when creating the destination thread.
export function resolveThreadHandoffTitle(thread: Pick<Thread, "title">): string {
  const title = thread.title.trim().replace(/\s+/g, " ");
  return title.length > 0 ? title : "Handoff";
}

export function buildThreadHandoffImportedMessages(
  thread: Pick<Thread, "messages">,
): ReadonlyArray<ThreadHandoffImportedMessage> {
  return thread.messages.filter(isImportableThreadMessage).map((message) => {
    const importedText =
      message.role === "user" ? stripEmbeddedAssistantSelections(message.text) : message.text;
    const importedMessage: ThreadHandoffImportedMessage = {
      messageId: MessageId.makeUnsafe(randomUUID()),
      role: message.role,
      text: importedText,
      createdAt: message.createdAt,
      updatedAt: message.completedAt ?? message.createdAt,
    };
    const attachments =
      message.attachments && message.attachments.length > 0
        ? message.attachments.map((attachment) =>
            attachment.type === "assistant-selection"
              ? {
                  type: attachment.type,
                  id: attachment.id,
                  assistantMessageId: attachment.assistantMessageId,
                  text: attachment.text,
                }
              : {
                  type: attachment.type,
                  id: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                },
          )
        : null;
    return attachments ? Object.assign(importedMessage, { attachments }) : importedMessage;
  });
}

export function buildThreadHandoffContextPreview(input: {
  readonly thread: Pick<
    Thread,
    "branch" | "messages" | "modelSelection" | "title" | "worktreePath"
  >;
  readonly latestUserMessageText: string;
}): string | null {
  const maxChars = calculateAvailableHandoffBootstrapChars(input.latestUserMessageText);
  if (maxChars <= 0) {
    return null;
  }
  const importedMessages = buildThreadHandoffImportedMessages(input.thread);
  if (importedMessages.length === 0) {
    return null;
  }
  return buildHandoffBootstrapTextFromImportedMessages({
    thread: input.thread,
    importedMessages,
    sourceProvider: input.thread.modelSelection.provider,
    maxChars,
  });
}

export function buildThreadHandoffImportedActivities(
  thread: Pick<Thread, "activities">,
): ReadonlyArray<OrchestrationThreadActivity> {
  return thread.activities.filter(isImportableThreadActivity).map((activity) => {
    const { sequence: _sequence, ...rest } = activity;
    return {
      ...rest,
      id: EventId.makeUnsafe(randomUUID()),
    };
  });
}

// Used by: ChatView fork command gating.
export function hasTransferableThreadMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(isImportableThreadMessage);
}

export function hasNativeThreadHandoffMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(
    (message) => isImportableThreadMessage(message) && message.source === "native",
  );
}

export function canCreateThreadHandoff(input: {
  readonly thread: Pick<Thread, "handoff" | "messages" | "session">;
  readonly isBusy?: boolean;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  if (input.isBusy || input.hasPendingApprovals || input.hasPendingUserInput) {
    return false;
  }
  const sessionStatus = input.thread.session?.orchestrationStatus;
  if (sessionStatus === "starting" || sessionStatus === "running") {
    return false;
  }
  const importedMessages = buildThreadHandoffImportedMessages(input.thread);
  if (importedMessages.length === 0) {
    return false;
  }
  if (input.thread.handoff !== null) {
    return hasNativeThreadHandoffMessages(input.thread);
  }
  return true;
}

export function resolveThreadHandoffModelSelection(input: {
  readonly sourceThread: Pick<Thread, "modelSelection">;
  readonly targetProvider: ProviderKind;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
}): ModelSelection {
  const isCompatibleSelection = (
    selection: ModelSelection | null | undefined,
  ): selection is ModelSelection => {
    if (!selection || selection.provider !== input.targetProvider) {
      return false;
    }
    return input.targetProvider !== "kilo" || selection.model.startsWith("kilo/");
  };

  const stickySelection = input.stickyModelSelectionByProvider[input.targetProvider];
  if (isCompatibleSelection(stickySelection)) {
    return stickySelection;
  }
  if (isCompatibleSelection(input.projectDefaultModelSelection)) {
    return input.projectDefaultModelSelection;
  }
  const defaultModel = getDefaultModel(input.targetProvider);
  if (!defaultModel) {
    throw new Error("Select a Pi model before handing off to Pi.");
  }
  return {
    provider: input.targetProvider,
    model: defaultModel,
  };
}
