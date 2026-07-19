// FILE: composerDraftAttachments.ts
// Purpose: Owns composer attachment identity, blob lifetime, persistence verification, and hydration.
// Exports: Attachment transitions used by persistence and action construction.

import { type ThreadId } from "@synara/contracts";
import * as Schema from "effect/Schema";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  PersistedComposerImageAttachment,
  shouldRemoveDraft,
  type ComposerAttachmentPersistenceResult,
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerPromptHistorySavedDraft,
  type ComposerThreadDraftState,
  type QueuedComposerTurn,
} from "./composerDraftDomain";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { deleteComposerImageBlob } from "./lib/composerImageBlobStore";
import {
  normalizeComposerImageSource,
  toPersistedComposerImageSource,
} from "./lib/composerImageSource";

const composerAttachmentPersistenceQueueByThreadId = new Map<string, Promise<void>>();
const composerAttachmentSyncGenerationByKey = new Map<string, number>();

function enqueueComposerAttachmentPersistence<Result>(
  threadId: ThreadId,
  operation: () => Promise<Result> | Result,
): Promise<Result> {
  const previous = composerAttachmentPersistenceQueueByThreadId.get(threadId);
  let result: Promise<Result>;
  if (previous) {
    result = previous.then(operation, operation);
  } else {
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  composerAttachmentPersistenceQueueByThreadId.set(threadId, settled);
  void settled.then(() => {
    if (composerAttachmentPersistenceQueueByThreadId.get(threadId) === settled) {
      composerAttachmentPersistenceQueueByThreadId.delete(threadId);
    }
  });
  return result;
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function mergeComposerImages(
  existingImages: ReadonlyArray<ComposerImageAttachment>,
  incomingImages: ReadonlyArray<ComposerImageAttachment>,
): ComposerImageAttachment[] | null {
  const existingIds = new Set(existingImages.map((image) => image.id));
  const existingDedupKeys = new Set(existingImages.map((image) => composerImageDedupKey(image)));
  const acceptedPreviewUrls = new Set(existingImages.map((image) => image.previewUrl));
  const acceptedIncoming: ComposerImageAttachment[] = [];
  for (const image of incomingImages) {
    const dedupKey = composerImageDedupKey(image);
    if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
      if (!acceptedPreviewUrls.has(image.previewUrl)) {
        revokeObjectPreviewUrl(image.previewUrl);
      }
      continue;
    }
    acceptedIncoming.push(image);
    existingIds.add(image.id);
    existingDedupKeys.add(dedupKey);
    acceptedPreviewUrls.add(image.previewUrl);
  }
  return acceptedIncoming.length > 0 ? [...existingImages, ...acceptedIncoming] : null;
}

export function composerFileDedupKey(file: ComposerFileAttachment): string {
  return `${file.mimeType}\u0000${file.sizeBytes}\u0000${file.name}`;
}

export function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeQueuedTurnPreviewUrls(queuedTurn: QueuedComposerTurn): void {
  if (queuedTurn.kind !== "chat") {
    return;
  }
  for (const image of queuedTurn.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}

export function revokePromptHistorySavedDraftPreviewUrls(
  savedDraft: ComposerPromptHistorySavedDraft | null | undefined,
): void {
  if (!savedDraft) {
    return;
  }
  for (const image of savedDraft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}

export function revokeDraftPreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
  for (const queuedTurn of draft.queuedTurns) {
    revokeQueuedTurnPreviewUrls(queuedTurn);
  }
  revokePromptHistorySavedDraftPreviewUrls(draft.promptHistorySavedDraft);
}

export function revokeDraftComposerImagePreviewUrls(
  draft: ComposerThreadDraftState | undefined,
): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
  revokePromptHistorySavedDraftPreviewUrls(draft.promptHistorySavedDraft);
}

export function isComposerImageBlobReferenced(
  draftsByThreadId: Readonly<Record<string, ComposerThreadDraftState | undefined>>,
  blobKey: string,
): boolean {
  if (blobKey.length === 0) return false;
  for (const draft of Object.values(draftsByThreadId)) {
    if (!draft) continue;
    if (draft.persistedAttachments.some((attachment) => attachment.blobKey === blobKey)) {
      return true;
    }
    if (
      draft.promptHistorySavedDraft?.persistedAttachments.some(
        (attachment) => attachment.blobKey === blobKey,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function findSupersededComposerImageBlobAttachments(
  previousAttachments: ReadonlyArray<PersistedComposerImageAttachment>,
  nextAttachments: ReadonlyArray<PersistedComposerImageAttachment>,
): PersistedComposerImageAttachment[] {
  const nextBlobKeys = new Set(
    nextAttachments.flatMap((attachment) => (attachment.blobKey ? [attachment.blobKey] : [])),
  );
  return previousAttachments.filter((attachment) => {
    const blobKey = attachment.blobKey;
    return Boolean(blobKey && !nextBlobKeys.has(blobKey));
  });
}

export function deletePersistedComposerImageBlobs(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
  getDraftsByThreadId: () => ComposerDraftStoreState["draftsByThreadId"],
): void {
  const candidateBlobKeys = new Set(
    attachments.flatMap((attachment) => (attachment.blobKey ? [attachment.blobKey] : [])),
  );
  if (candidateBlobKeys.size === 0) return;

  // Several product flows copy composer state before the destination is ever
  // mounted. Those drafts temporarily share the source blob key, so ownership
  // must be checked after the current store mutation has committed.
  Promise.resolve().then(() => {
    const draftsByThreadId = getDraftsByThreadId();
    for (const blobKey of candidateBlobKeys) {
      if (isComposerImageBlobReferenced(draftsByThreadId, blobKey)) continue;
      void deleteComposerImageBlob(blobKey).catch((error) => {
        console.warn("[composer-images] Could not delete persisted image blob", error);
      });
    }
  });
}

export function deleteDraftComposerImageBlobs(
  draft: ComposerThreadDraftState | undefined,
  getDraftsByThreadId: () => ComposerDraftStoreState["draftsByThreadId"],
): void {
  if (!draft) return;
  deletePersistedComposerImageBlobs(draft.persistedAttachments, getDraftsByThreadId);
  if (draft.promptHistorySavedDraft) {
    deletePersistedComposerImageBlobs(
      draft.promptHistorySavedDraft.persistedAttachments,
      getDraftsByThreadId,
    );
  }
}

export function normalizePersistedAttachment(
  value: unknown,
): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  const blobKey = candidate.blobKey;
  const source = normalizeComposerImageSource(candidate.source);
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    id.length === 0 ||
    !(
      (typeof dataUrl === "string" && dataUrl.length > 0) ||
      (typeof blobKey === "string" && blobKey.length > 0)
    )
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    ...(typeof dataUrl === "string" && dataUrl.length > 0 ? { dataUrl } : {}),
    ...(typeof blobKey === "string" && blobKey.length > 0 ? { blobKey } : {}),
    ...(source ? { source } : {}),
  };
}

export function toStorageSafePersistedAttachment(
  attachment: PersistedComposerImageAttachment,
): PersistedComposerImageAttachment {
  const { source: _source, ...attachmentWithoutSource } = attachment;
  const source = toPersistedComposerImageSource(attachment.source);
  return {
    ...attachmentWithoutSource,
    ...(source ? { source } : {}),
  };
}

function persistImageAttachmentFromDataUrl(input: {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}): PersistedComposerImageAttachment | null {
  return normalizePersistedAttachment(input);
}

export function persistQueuedComposerImages(
  images: ReadonlyArray<ComposerImageAttachment>,
): PersistedComposerImageAttachment[] {
  return images.flatMap((image) => {
    if (!image.previewUrl.startsWith("data:")) {
      return [];
    }
    const normalized = persistImageAttachmentFromDataUrl({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: image.previewUrl,
    });
    return normalized ? [normalized] : [];
  });
}

type PersistedAttachmentIdsRead =
  | { available: true; attachmentIds: string[] }
  | { available: false };

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPersistedComposerDraftsRecord(): Record<string, unknown> | null {
  const persisted = asUnknownRecord(
    getLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY, Schema.Unknown),
  );
  if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) return null;
  const state = asUnknownRecord(persisted.state);
  return state ? asUnknownRecord(state.draftsByThreadId) : null;
}

function decodePersistedAttachmentIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const attachmentIds: string[] = [];
  for (const candidate of value) {
    try {
      attachmentIds.push(Schema.decodeUnknownSync(PersistedComposerImageAttachment)(candidate).id);
    } catch {
      // Ignore unrelated malformed entries. The attempted attachment still has
      // to decode successfully and appear below before its native capture is acknowledged.
    }
  }
  return attachmentIds;
}

type ComposerDraftStoreSet = (
  partial:
    | ComposerDraftStoreState
    | Partial<ComposerDraftStoreState>
    | ((
        state: ComposerDraftStoreState,
      ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
  replace?: false,
) => void;

type ComposerDraftStoreGet = () => Pick<ComposerDraftStoreState, "draftsByThreadId">;

interface ComposerAttachmentSlotView {
  readonly images: ComposerImageAttachment[];
  readonly nonPersistedImageIds: string[];
  readonly persistedAttachments: PersistedComposerImageAttachment[];
}

interface ComposerAttachmentSlot {
  readonly key: string;
  readonly read: (draft: ComposerThreadDraftState) => ComposerAttachmentSlotView | null;
  readonly write: (
    draft: ComposerThreadDraftState,
    updates: {
      persistedAttachments: PersistedComposerImageAttachment[];
      nonPersistedImageIds: string[];
    },
  ) => ComposerThreadDraftState;
  readonly readStoredAttachmentIds: (storedDraft: Record<string, unknown>) => string[] | null;
  readonly stageNonPersistedImageIds: (
    view: ComposerAttachmentSlotView,
    stagedAttachmentIds: ReadonlySet<string>,
  ) => string[];
}

export const DRAFT_ATTACHMENT_SLOT: ComposerAttachmentSlot = {
  key: "draft",
  read: (draft) => draft,
  write: (draft, updates) => ({ ...draft, ...updates }),
  readStoredAttachmentIds: (storedDraft) => decodePersistedAttachmentIds(storedDraft.attachments),
  stageNonPersistedImageIds: (view, stagedAttachmentIds) =>
    view.nonPersistedImageIds.filter((id) => !stagedAttachmentIds.has(id)),
};

export const PROMPT_HISTORY_ATTACHMENT_SLOT: ComposerAttachmentSlot = {
  key: "prompt-history",
  read: (draft) => draft.promptHistorySavedDraft,
  write: (draft, updates) =>
    draft.promptHistorySavedDraft
      ? { ...draft, promptHistorySavedDraft: { ...draft.promptHistorySavedDraft, ...updates } }
      : draft,
  readStoredAttachmentIds: (storedDraft) => {
    const savedDraft = asUnknownRecord(storedDraft.promptHistorySavedDraft);
    if (!savedDraft) return null;
    return decodePersistedAttachmentIds(savedDraft.attachments ?? []);
  },
  stageNonPersistedImageIds: (view, stagedAttachmentIds) =>
    view.images.map((image) => image.id).filter((id) => !stagedAttachmentIds.has(id)),
};

function readPersistedAttachmentIdsFromStorage(
  threadId: ThreadId,
  slot: ComposerAttachmentSlot,
): PersistedAttachmentIdsRead {
  if (threadId.length === 0) {
    return { available: false };
  }
  try {
    const draft = asUnknownRecord(readPersistedComposerDraftsRecord()?.[threadId]);
    if (!draft) return { available: false };
    const attachmentIds = slot.readStoredAttachmentIds(draft);
    if (!attachmentIds) return { available: false };
    return {
      available: true,
      attachmentIds,
    };
  } catch {
    return { available: false };
  }
}

function verifyPersistedAttachmentsForSlot(
  threadId: ThreadId,
  attachments: PersistedComposerImageAttachment[],
  get: ComposerDraftStoreGet,
  set: ComposerDraftStoreSet,
  slot: ComposerAttachmentSlot,
  applyStateUpdate: boolean,
  flushPersistStorage: () => void,
): ComposerAttachmentPersistenceResult {
  let persistedIdsRead: PersistedAttachmentIdsRead = { available: false };
  try {
    flushPersistStorage();
    persistedIdsRead = readPersistedAttachmentIdsFromStorage(threadId, slot);
  } catch {
    persistedIdsRead = { available: false };
  }
  const persistedIdSet = new Set(persistedIdsRead.available ? persistedIdsRead.attachmentIds : []);
  let draftPresent = false;
  let verifiedAttachmentIds = new Set<string>();
  let retainedAttachmentIds = new Set<string>();
  const verifyDraft = (current: ComposerThreadDraftState): ComposerThreadDraftState | null => {
    const view = slot.read(current);
    if (!view) return null;
    draftPresent = true;
    const imageIdSet = new Set(view.images.map((image) => image.id));
    const retainedAttachments = attachments.filter((attachment) => imageIdSet.has(attachment.id));
    retainedAttachmentIds = new Set(retainedAttachments.map((attachment) => attachment.id));
    const persistedAttachments = persistedIdsRead.available
      ? retainedAttachments.filter((attachment) => persistedIdSet.has(attachment.id))
      : retainedAttachments;
    verifiedAttachmentIds = new Set(persistedAttachments.map((attachment) => attachment.id));
    const nonPersistedImageIds = persistedIdsRead.available
      ? view.images.map((image) => image.id).filter((imageId) => !persistedIdSet.has(imageId))
      : [...new Set([...view.nonPersistedImageIds, ...retainedAttachmentIds])];
    return slot.write(current, { persistedAttachments, nonPersistedImageIds });
  };
  if (applyStateUpdate) {
    set((state) => {
      const current = state.draftsByThreadId[threadId];
      const nextDraft = current ? verifyDraft(current) : null;
      if (!nextDraft) {
        return state;
      }
      const nextDraftsByThreadId = { ...state.draftsByThreadId };
      if (shouldRemoveDraft(nextDraft)) {
        delete nextDraftsByThreadId[threadId];
      } else {
        nextDraftsByThreadId[threadId] = nextDraft;
      }
      return { draftsByThreadId: nextDraftsByThreadId };
    });
  } else {
    // Superseded by a newer sync for this slot: report on this call's own
    // attachments without rolling back the newer staged draft state.
    const current = get().draftsByThreadId[threadId];
    if (current) verifyDraft(current);
  }
  const acceptedAttachmentIds = persistedIdsRead.available
    ? verifiedAttachmentIds
    : retainedAttachmentIds;
  const rejectedAttachments = attachments.filter(
    (attachment) => !acceptedAttachmentIds.has(attachment.id),
  );
  deletePersistedComposerImageBlobs(rejectedAttachments, () => get().draftsByThreadId);
  if (!draftPresent || rejectedAttachments.length > 0) return "rejected";
  return persistedIdsRead.available ? "persisted" : "unverified";
}

export function syncPersistedAttachmentsForSlot(
  threadId: ThreadId,
  attachments: PersistedComposerImageAttachment[],
  get: ComposerDraftStoreGet,
  set: ComposerDraftStoreSet,
  slot: ComposerAttachmentSlot,
  flushPersistStorage: () => void,
): Promise<ComposerAttachmentPersistenceResult> {
  if (threadId.length === 0) {
    return Promise.resolve("rejected");
  }
  const generationKey = `${slot.key}:${threadId}`;
  const generation = (composerAttachmentSyncGenerationByKey.get(generationKey) ?? 0) + 1;
  composerAttachmentSyncGenerationByKey.set(generationKey, generation);
  try {
    // Stage synchronously: a reload right after this call must already see the
    // attempted attachments in the persisted snapshot, even while an earlier
    // sync for this thread is still verifying.
    const currentDraft = get().draftsByThreadId[threadId];
    const previousAttachments = currentDraft
      ? (slot.read(currentDraft)?.persistedAttachments ?? [])
      : [];
    const supersededBlobAttachments = findSupersededComposerImageBlobAttachments(
      previousAttachments,
      attachments,
    );
    const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
    set((state) => {
      const current = state.draftsByThreadId[threadId];
      const view = current ? slot.read(current) : null;
      if (!current || !view) {
        return state;
      }
      const nextDraft = slot.write(current, {
        persistedAttachments: attachments,
        nonPersistedImageIds: slot.stageNonPersistedImageIds(view, attachmentIdSet),
      });
      const nextDraftsByThreadId = { ...state.draftsByThreadId };
      if (shouldRemoveDraft(nextDraft)) {
        delete nextDraftsByThreadId[threadId];
      } else {
        nextDraftsByThreadId[threadId] = nextDraft;
      }
      return { draftsByThreadId: nextDraftsByThreadId };
    });
    deletePersistedComposerImageBlobs(supersededBlobAttachments, () => get().draftsByThreadId);
  } catch (error) {
    return Promise.reject(error);
  }
  // Verification stays serialized per thread (across both slots) so overlapping
  // verifications cannot roll back each other's committed state.
  return enqueueComposerAttachmentPersistence(threadId, () =>
    verifyPersistedAttachmentsForSlot(
      threadId,
      attachments,
      get,
      set,
      slot,
      composerAttachmentSyncGenerationByKey.get(generationKey) === generation,
      flushPersistStorage,
    ),
  );
}

function hydreatePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  if (!attachment.dataUrl) return null;
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const previewUrl = attachment.dataUrl;
    if (!previewUrl) return [];
    const file = hydreatePersistedComposerImageAttachment(attachment);
    if (!file) return [];
    const source = normalizeComposerImageSource(attachment.source);

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl,
        file,
        ...(source ? { source } : {}),
      } satisfies ComposerImageAttachment,
    ];
  });
}
