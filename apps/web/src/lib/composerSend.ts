// FILE: composerSend.ts
// Purpose: Shared composer send helpers for image intake, prompt formatting, and upload payloads.
// Layer: Web composer utility
// Depends on: provider/model contracts plus composer draft attachment shapes.

import {
  MessageId,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ClaudeCodeEffort,
  type ProviderKind,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix, getModelCapabilities } from "@t3tools/shared/model";

import type {
  ComposerAssistantSelectionAttachment,
  ComposerImageAttachment,
} from "../composerDraftStore";
import { randomUUID } from "./utils";

export const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024),
)}MB`;

export interface ComposerImageBuildResult {
  images: ComposerImageAttachment[];
  error: string | null;
}

// Converts File objects into the exact attachment draft shape used by the chat composer.
export function buildComposerImageAttachmentsFromFiles(input: {
  files: readonly File[];
  existingAttachmentCount: number;
}): ComposerImageBuildResult {
  const images: ComposerImageAttachment[] = [];
  let nextAttachmentCount = input.existingAttachmentCount;
  let error: string | null = null;

  for (const file of input.files) {
    if (!file.type.startsWith("image/")) {
      error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
      continue;
    }
    if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
      continue;
    }
    if (nextAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`;
      break;
    }

    images.push({
      type: "image",
      id: randomUUID(),
      name: file.name || "image",
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: URL.createObjectURL(file),
      file,
    });
    nextAttachmentCount += 1;
  }

  return { images, error };
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function cloneComposerImageAttachment(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

// Provider-specific prompt massaging. Claude prompt-injected efforts must be
// applied before filtering skill/mention references and before dispatch.
export function formatOutgoingComposerPrompt(params: {
  provider: ProviderKind;
  model: string | null;
  effort: string | null;
  text: string;
}): string {
  const caps = getModelCapabilities(params.provider, params.model);
  if (params.effort && caps.promptInjectedEffortLevels.includes(params.effort)) {
    return applyClaudePromptEffortPrefix(params.text, params.effort as ClaudeCodeEffort | null);
  }
  return params.text;
}

export function resolvePromptEffortFromModelSelection(
  modelSelection: ModelSelection,
): string | null {
  switch (modelSelection.provider) {
    case "codex":
      return modelSelection.options?.reasoningEffort ?? null;
    case "claudeAgent":
      return modelSelection.options?.effort ?? null;
    case "cursor":
      return modelSelection.options?.reasoningEffort ?? null;
    case "gemini":
      return (
        modelSelection.options?.thinkingLevel ??
        (modelSelection.options?.thinkingBudget !== undefined
          ? String(modelSelection.options.thinkingBudget)
          : null)
      );
    case "grok":
      return modelSelection.options?.reasoningEffort ?? null;
    case "pi":
      return modelSelection.options?.thinkingLevel ?? null;
    case "kilo":
    case "opencode":
      return null;
  }
}

export async function buildUploadComposerAttachments(input: {
  images: ReadonlyArray<ComposerImageAttachment>;
  assistantSelections: ReadonlyArray<ComposerAssistantSelectionAttachment>;
}): Promise<UploadChatAttachment[]> {
  return Promise.all([
    ...input.assistantSelections.map((selection) =>
      Promise.resolve({
        type: "assistant-selection" as const,
        assistantMessageId: MessageId.makeUnsafe(selection.assistantMessageId),
        text: selection.text,
      }),
    ),
    ...input.images.map(async (image) => ({
      type: "image" as const,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await readFileAsDataUrl(image.file),
    })),
  ]);
}
