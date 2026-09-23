// FILE: threadHandoff.ts
// Purpose: Builds client-side handoff provenance labels and imported transcript payloads.
// Layer: Web handoff utilities
// Exports: target-provider, transcript, and model-selection helpers.

import {
  MessageId,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettingsView,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { type Thread } from "../types";
import { DEFAULT_PROVIDER_ORDER } from "../providerOrdering";
import { stripEmbeddedAssistantSelections } from "./assistantSelections";
import { extractTrailingBrowserAnnotations } from "./browserAnnotations";
import { findProviderStatus, isProviderUsable } from "./providerAvailability";
import { randomUUID } from "./utils";

function isImportableThreadMessage(
  message: Thread["messages"][number],
): message is Thread["messages"][number] & {
  role: "user" | "assistant";
} {
  return (message.role === "user" || message.role === "assistant") && message.streaming === false;
}

function isEligibleHandoffTargetProvider(input: {
  readonly sourceProvider: ProviderKind;
  readonly targetProvider: ProviderKind;
  readonly targetProviderEnabled: boolean | null | undefined;
  readonly targetProviderStatus: ServerProviderStatus | null | undefined;
}): boolean {
  return (
    input.targetProvider !== input.sourceProvider &&
    input.targetProviderEnabled === true &&
    input.targetProviderStatus?.provider === input.targetProvider &&
    isProviderUsable(input.targetProviderStatus)
  );
}

export function resolveAvailableHandoffTargetProviders(input: {
  readonly sourceProvider: ProviderKind;
  readonly providerSettings: ServerSettingsView["providers"] | null | undefined;
  readonly providerStatuses: readonly ServerProviderStatus[];
}): ReadonlyArray<ProviderKind> {
  return DEFAULT_PROVIDER_ORDER.filter((targetProvider) =>
    isEligibleHandoffTargetProvider({
      sourceProvider: input.sourceProvider,
      targetProvider,
      targetProviderEnabled: input.providerSettings?.[targetProvider].enabled,
      targetProviderStatus: findProviderStatus(input.providerStatuses, targetProvider),
    }),
  );
}

export function resolveThreadHandoffBadgeLabel(thread: Pick<Thread, "handoff">): string | null {
  if (!thread.handoff) {
    return null;
  }
  return `Handoff from ${PROVIDER_DISPLAY_NAMES[thread.handoff.sourceProvider]}`;
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

export function resolveThreadHandoffModelSelection(input: {
  readonly sourceThread: Pick<Thread, "modelSelection">;
  readonly targetProvider: ProviderKind;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
}): ModelSelection {
  const isCompatibleSelection = (
    selection: ModelSelection | null | undefined,
  ): selection is ModelSelection => {
    return Boolean(selection && selection.provider === input.targetProvider);
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
