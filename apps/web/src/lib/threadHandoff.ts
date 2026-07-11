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
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { inferLegacyProviderKindFromModelSelection } from "@synara/shared/providerInstances";
import type { ProviderInstanceOption } from "../appSettings";
import { type Thread } from "../types";
import { stripEmbeddedAssistantSelections } from "./assistantSelections";
import { randomUUID } from "./utils";

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

export function resolveAvailableHandoffTargets(input: {
  readonly sourceProvider: ProviderKind;
  readonly sourceProviderInstanceId?: ProviderInstanceId | null | undefined;
  readonly providerInstances: ReadonlyArray<ProviderInstanceOption>;
}): ReadonlyArray<ThreadHandoffTarget> {
  const sourceInstanceId = input.sourceProviderInstanceId ?? input.sourceProvider;
  const providerRank = new Map(HANDOFF_PROVIDER_ORDER.map((provider, index) => [provider, index]));
  return input.providerInstances
    .filter((instance) => instance.enabled)
    .filter(
      (instance) =>
        instance.provider !== input.sourceProvider || instance.instanceId !== sourceInstanceId,
    )
    .toSorted((left, right) => {
      const providerDelta =
        (providerRank.get(left.provider) ?? HANDOFF_PROVIDER_ORDER.length) -
        (providerRank.get(right.provider) ?? HANDOFF_PROVIDER_ORDER.length);
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
  readonly targetProviderInstanceId?: ProviderInstanceId | null | undefined;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}): ModelSelection {
  const targetInstanceId = input.targetProviderInstanceId ?? input.targetProvider;
  const isCompatibleSelection = (
    selection: ModelSelection | null | undefined,
  ): selection is ModelSelection => {
    if (
      !selection ||
      inferLegacyProviderKindFromModelSelection(selection) !== input.targetProvider
    ) {
      return false;
    }
    const selectionInstanceId = selection.instanceId;
    if (selectionInstanceId !== targetInstanceId) {
      return false;
    }
    return input.targetProvider !== "kilo" || selection.model.startsWith("kilo/");
  };

  const stickySelection = input.stickyModelSelectionByProvider[targetInstanceId];
  const withTargetInstance = (selection: ModelSelection): ModelSelection => ({
    ...selection,
    instanceId: targetInstanceId,
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
    instanceId: targetInstanceId,
    model: defaultModel,
  });
}
