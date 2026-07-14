// FILE: composerSend.ts
// Purpose: Shared composer send helpers for attachment intake, prompt formatting, and upload payloads.
// Layer: Web composer utility
// Depends on: provider/model contracts plus composer draft attachment shapes.

import {
  type ChatFileAttachment,
  type ChatImageAttachment,
  MessageId,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ClaudeCodeEffort,
  type ProviderKind,
  type UploadChatAttachment,
} from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { applyClaudePromptEffortPrefix, getModelCapabilities } from "@synara/shared/model";

import type {
  ComposerAssistantSelectionAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../composerDraftStore";
import { randomUUID } from "./utils";
import { resolveWsHttpUrl } from "./wsHttpUrl";

const ATTACHMENT_CANCEL_CONCURRENCY = 2;
const ATTACHMENT_CANCEL_BODY_MAX_BYTES = 512;

export const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024),
)}MB`;
export const FILE_SIZE_LIMIT_LABEL = `${Math.round(
  PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024),
)}MB`;

export interface ComposerImageBuildResult {
  images: ComposerImageAttachment[];
  error: string | null;
}

export interface ComposerFileBuildResult {
  files: ComposerFileAttachment[];
  error: string | null;
}

// Centralizes the shared file/count/size guard while each attachment type maps its own draft shape.
function collectComposerAttachmentFiles(input: {
  files: readonly File[];
  existingAttachmentCount: number;
  maxBytes: number;
  sizeLimitLabel: string;
  acceptsFile: (file: File) => boolean;
  unsupportedFileError?: (file: File) => string | null;
}): { files: File[]; error: string | null } {
  const files: File[] = [];
  let nextAttachmentCount = input.existingAttachmentCount;
  let error: string | null = null;

  for (const file of input.files) {
    if (!input.acceptsFile(file)) {
      error = input.unsupportedFileError?.(file) ?? error;
      continue;
    }
    if (file.size > input.maxBytes) {
      error = `'${file.name}' exceeds the ${input.sizeLimitLabel} attachment limit.`;
      continue;
    }
    if (nextAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`;
      break;
    }

    files.push(file);
    nextAttachmentCount += 1;
  }

  return { files, error };
}

// Converts File objects into the exact attachment draft shape used by the chat composer.
export function buildComposerImageAttachmentsFromFiles(input: {
  files: readonly File[];
  existingAttachmentCount: number;
}): ComposerImageBuildResult {
  const result = collectComposerAttachmentFiles({
    files: input.files,
    existingAttachmentCount: input.existingAttachmentCount,
    maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    sizeLimitLabel: IMAGE_SIZE_LIMIT_LABEL,
    acceptsFile: (file) => file.type.startsWith("image/"),
    unsupportedFileError: (file) =>
      `Unsupported file type for '${file.name}'. Please attach image files only.`,
  });

  const images = result.files.map<ComposerImageAttachment>((file) => ({
    type: "image",
    id: randomUUID(),
    name: file.name || "image",
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  }));

  return { images, error: result.error };
}

// Converts non-image File objects into in-memory file attachment drafts.
export function buildComposerFileAttachmentsFromFiles(input: {
  files: readonly File[];
  existingAttachmentCount: number;
}): ComposerFileBuildResult {
  const result = collectComposerAttachmentFiles({
    files: input.files,
    existingAttachmentCount: input.existingAttachmentCount,
    maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    sizeLimitLabel: FILE_SIZE_LIMIT_LABEL,
    acceptsFile: (file) => !file.type.startsWith("image/"),
  });

  const files = result.files.map<ComposerFileAttachment>((file) => ({
    type: "file",
    id: randomUUID(),
    name: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    file,
  }));

  return { files, error: result.error };
}

// Draft persistence and previews still need a local data URL. Network sends use
// the bounded binary upload path below and never place this value on RPC.
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read attachment data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read attachment."));
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
    case "droid":
      return modelSelection.options?.reasoningEffort ?? null;
    case "pi":
      return modelSelection.options?.thinkingLevel ?? null;
    case "kilo":
    case "opencode":
      return null;
  }
}

export interface StagedComposerAttachments {
  readonly attachments: UploadChatAttachment[];
  /** Marks an accepted dispatch as authoritative. Cleanup becomes a no-op. */
  readonly commit: () => void;
  /** Best-effort compensation for a rejected/abandoned dispatch. Never rejects. */
  readonly cleanup: () => Promise<void>;
  /** Runs dispatch with commit-on-success and cleanup-on-failure semantics. */
  readonly runWithDispatch: <A>(
    dispatch: (attachments: UploadChatAttachment[]) => Promise<A>,
  ) => Promise<A>;
}

function isManagedAttachmentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-z0-9_-]+$/i.test(value)
  );
}

async function cancelManagedAttachments(attachmentIds: readonly string[]): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < attachmentIds.length) {
      const attachmentId = attachmentIds[nextIndex];
      nextIndex += 1;
      if (!attachmentId) continue;
      const body = JSON.stringify({ attachmentId });
      if (new TextEncoder().encode(body).byteLength > ATTACHMENT_CANCEL_BODY_MAX_BYTES) continue;
      try {
        await fetch(resolveWsHttpUrl(ATTACHMENT_CANCEL_ROUTE_PATH), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch {
        // Staged attachments also have a server-owned expiry. Compensation is
        // deliberately best-effort and must never replace the dispatch/upload error.
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(ATTACHMENT_CANCEL_CONCURRENCY, attachmentIds.length) },
      () => worker(),
    ),
  );
}

export async function stageUploadComposerAttachments(input: {
  threadId: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  files?: ReadonlyArray<ComposerFileAttachment>;
  assistantSelections: ReadonlyArray<ComposerAssistantSelectionAttachment>;
}): Promise<StagedComposerAttachments> {
  const attachments: UploadChatAttachment[] = input.assistantSelections.map((selection) => ({
    type: "assistant-selection" as const,
    assistantMessageId: MessageId.makeUnsafe(selection.assistantMessageId),
    text: selection.text,
  }));

  // Upload sequentially so selecting several maximum-size files never creates a
  // burst of concurrent body buffers. The RPC turn then carries only short ids.
  const managedAttachmentIds: string[] = [];
  try {
    for (const attachment of [...input.images, ...(input.files ?? [])]) {
      const params = new URLSearchParams({
        threadId: input.threadId,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
      const response = await fetch(
        resolveWsHttpUrl(`${ATTACHMENT_UPLOAD_ROUTE_PATH}?${params.toString()}`),
        {
          method: "POST",
          credentials: "include",
          body: attachment.file,
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | ChatImageAttachment
        | ChatFileAttachment
        | { readonly error?: unknown }
        | null;
      if (!response.ok || !payload || !("id" in payload) || !isManagedAttachmentId(payload.id)) {
        const message =
          payload && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Attachment upload failed with status ${response.status}.`;
        throw new Error(message);
      }
      managedAttachmentIds.push(payload.id);
      attachments.push(payload);
    }
  } catch (error) {
    await cancelManagedAttachments(managedAttachmentIds);
    throw error;
  }

  let disposition: "pending" | "committed" | "cleaned" = "pending";
  const cleanup = async () => {
    if (disposition !== "pending") return;
    disposition = "cleaned";
    await cancelManagedAttachments(managedAttachmentIds);
  };
  const commit = () => {
    if (disposition === "pending") disposition = "committed";
  };
  const runWithDispatch = async <A>(
    dispatch: (dispatchAttachments: UploadChatAttachment[]) => Promise<A>,
  ): Promise<A> => {
    try {
      const result = await dispatch(attachments);
      commit();
      return result;
    } catch (error) {
      await cleanup();
      throw error;
    }
  };

  return { attachments, commit, cleanup, runWithDispatch };
}

// Compatibility wrapper for callers that have not yet adopted the explicit
// commit/cleanup lifecycle. Sequential upload failure compensation still applies.
export async function buildUploadComposerAttachments(input: {
  threadId: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  files?: ReadonlyArray<ComposerFileAttachment>;
  assistantSelections: ReadonlyArray<ComposerAssistantSelectionAttachment>;
}): Promise<UploadChatAttachment[]> {
  return (await stageUploadComposerAttachments(input)).attachments;
}
