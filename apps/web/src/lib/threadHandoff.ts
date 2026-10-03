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
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import type { ProviderInstanceOption } from "../appSettings";
import { type Thread } from "../types";
import { DEFAULT_PROVIDER_ORDER } from "../providerOrdering";
import { stripEmbeddedAssistantSelections } from "./assistantSelections";
import { extractTrailingBrowserAnnotations } from "./browserAnnotations";
import { isCompletedContextCompaction } from "./contextWindow";
import { findProviderStatus, isProviderUsable } from "./providerAvailability";
import { randomUUID } from "./utils";

const IMPORTABLE_THREAD_ACTIVITY_KINDS = new Set([
  "account.rate-limits.updated",
  "account.rate-limited",
  "context-compaction",
  "context-window.updated",
]);

export interface ThreadHandoffTarget {
  readonly provider: ProviderKind;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

function isImportableThreadMessage(
  message: Thread["messages"][number],
): message is Thread["messages"][number] & {
  role: "user" | "assistant";
} {
  return (message.role === "user" || message.role === "assistant") && message.streaming === false;
}

/** True when a handoff or fork of this thread would carry at least one message. */
export function hasImportableThreadMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(isImportableThreadMessage);
}

function isImportableThreadActivity(
  activity: Thread["activities"][number],
): activity is OrchestrationThreadActivity {
  return IMPORTABLE_THREAD_ACTIVITY_KINDS.has(activity.kind);
}

export function resolveAvailableHandoffTargets(input: {
  readonly sourceProvider: ProviderKind;
  readonly sourceProviderInstanceId?: ProviderInstanceId | null | undefined;
  readonly providerInstances: ReadonlyArray<ProviderInstanceOption>;
  readonly providerStatuses: readonly ServerProviderStatus[];
}): ReadonlyArray<ThreadHandoffTarget> {
  const sourceInstanceId = input.sourceProviderInstanceId ?? input.sourceProvider;
  const providerRank = new Map(DEFAULT_PROVIDER_ORDER.map((provider, index) => [provider, index]));
  return input.providerInstances
    .filter((instance) => instance.enabled)
    .filter((instance) =>
      isProviderUsable(
        findProviderStatus(input.providerStatuses, instance.provider, instance.instanceId),
      ),
    )
    .filter(
      (instance) =>
        instance.provider !== input.sourceProvider || instance.instanceId !== sourceInstanceId,
    )
    .toSorted((left, right) => {
      const providerDelta =
        (providerRank.get(left.provider) ?? DEFAULT_PROVIDER_ORDER.length) -
        (providerRank.get(right.provider) ?? DEFAULT_PROVIDER_ORDER.length);
      if (providerDelta !== 0) {
        return providerDelta;
      }
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    })
    .map((instance) => ({
      provider: instance.provider,
      instanceId: instance.instanceId,
      label: instance.label,
    }));
}

export function resolveThreadHandoffBadgeLabel(thread: Pick<Thread, "handoff">): string | null {
  if (!thread.handoff) {
    return null;
  }
  return `Handoff from ${PROVIDER_DISPLAY_NAMES[thread.handoff.sourceProvider]}`;
}

// Preserve the visible source thread name when creating the destination thread.
export function resolveThreadHandoffTitle(thread: Pick<Thread, "title">): string {
  const title = thread.title.trim().replace(/\s+/g, " ");
  return title.length > 0 ? title : "Handoff";
}

export function buildThreadHandoffImportedMessages(
  thread: Pick<Thread, "messages">,
  // Forking from a message footer carries only the transcript up to that turn, so
  // the new thread starts exactly where the user clicked. Omitted = whole thread.
  options?: { readonly throughMessageId?: MessageId | null },
): ReadonlyArray<ThreadHandoffImportedMessage> {
  const importable = thread.messages.filter(isImportableThreadMessage);
  const cutoffId = options?.throughMessageId ?? null;
  const cutoffIndex = cutoffId ? importable.findIndex((message) => message.id === cutoffId) : -1;
  const scopedMessages = cutoffIndex >= 0 ? importable.slice(0, cutoffIndex + 1) : importable;
  return scopedMessages.map((message) => {
    const importedMessageId = MessageId.makeUnsafe(randomUUID());
    let importedText = message.text;
    if (message.role === "user") {
      const extractedBrowserAnnotations = extractTrailingBrowserAnnotations(
        message.text,
        message.id,
      );
      const visibleAndContextText = stripEmbeddedAssistantSelections(
        extractedBrowserAnnotations.promptText,
      );
      // Browser annotation ids and tab ids are scoped to the source thread's
      // live browser session. Carrying them into a handoff would advertise an
      // exact-page navigation target that the destination thread cannot
      // resolve, so import only the visible user/context text.
      importedText = visibleAndContextText;
    }
    const importedMessage: ThreadHandoffImportedMessage = {
      messageId: importedMessageId,
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

export function buildThreadHandoffImportedActivities(
  thread: Pick<Thread, "activities">,
): ReadonlyArray<OrchestrationThreadActivity> {
  // Activity appends are not transactional. Start context history at the latest
  // durable boundary so a partial handoff can never persist already-invalid usage.
  let latestCompactionIndex = -1;
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index];
    if (activity && isCompletedContextCompaction(activity)) {
      latestCompactionIndex = index;
      break;
    }
  }

  return thread.activities
    .filter(
      (activity, index) =>
        isImportableThreadActivity(activity) &&
        (latestCompactionIndex < 0 ||
          (activity.kind !== "context-window.updated" && activity.kind !== "context-compaction") ||
          index >= latestCompactionIndex),
    )
    .map((activity) => {
      const { sequence: _sequence, ...rest } = activity;
      return {
        ...rest,
        id: EventId.makeUnsafe(randomUUID()),
      };
    });
}

export function hasNativeThreadHandoffMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(
    (message) =>
      isImportableThreadMessage(message) &&
      (message.source === "native" || message.source === "async-user-input"),
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

export interface ThreadHandoffAvailability {
  // "Hand off thread" — create a new thread on another provider.
  readonly providerHandoff: boolean;
  // "Hand off to new worktree" / "Hand off to local" — move the same thread's workspace.
  readonly workspaceHandoff: boolean;
}

/**
 * Single gating decision for every Hand off surface (chat header, sidebar
 * context menu, composer "Work in" menu). Group chats hand off between
 * providers like ordinary threads but have no repo checkout to move, and the
 * coordinator is a single per-group identity — a hand-off copy would read as a
 * second coordinator.
 */
export function resolveThreadHandoffAvailability(input: {
  readonly isGroupContainer: boolean;
  readonly isCoordinatorThread: boolean;
}): ThreadHandoffAvailability {
  return {
    providerHandoff: !input.isCoordinatorThread,
    workspaceHandoff: !input.isGroupContainer && !input.isCoordinatorThread,
  };
}

export function resolveThreadHandoffModelSelection(input: {
  readonly sourceThread: Pick<Thread, "modelSelection">;
  readonly targetProvider: ProviderKind;
  readonly targetProviderInstanceId?: ProviderInstanceId | null | undefined;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}): ModelSelection {
  const targetInstanceId = input.targetProviderInstanceId ?? input.targetProvider;
  const isCompatibleSelection = (
    selection: ModelSelection | null | undefined,
  ): selection is ModelSelection => {
    return Boolean(selection && selection.provider === input.targetProvider);
  };

  const stickySelection = input.stickyModelSelectionByProvider[targetInstanceId];
  const withTargetInstance = (selection: ModelSelection): ModelSelection => ({
    ...selection,
    ...(input.targetProviderInstanceId ? { instanceId: input.targetProviderInstanceId } : {}),
  });

  if (isCompatibleSelection(stickySelection)) {
    return withTargetInstance(stickySelection);
  }
  if (isCompatibleSelection(input.projectDefaultModelSelection)) {
    return withTargetInstance(input.projectDefaultModelSelection);
  }
  const defaultModel = getDefaultModel(input.targetProvider);
  if (!defaultModel) {
    throw new Error("Select a Pi model before handing off to Pi.");
  }
  return withTargetInstance({
    provider: input.targetProvider,
    model: defaultModel,
  });
}
