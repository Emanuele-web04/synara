// FILE: appSnapIntake.ts
// Purpose: Turns a desktop AppSnap capture into a persisted composer image attachment.
// Layer: Web composer domain
// Depends on: composer draft store, composer image intake, and AppSnap icon cache.

import type { DesktopAppSnapCapture, ThreadId } from "@synara/contracts";

import { persistAppSnapIcon, readAppSnapIcon } from "./lib/appSnapIconStore";
import { deleteComposerImageBlob, persistComposerImageBlob } from "./lib/composerImageBlobStore";
import { type ComposerAppSnapSource } from "./lib/composerImageSource";
import {
  effectiveComposerAttachmentCount,
  prepareComposerImageAttachmentsFromFiles,
} from "./lib/composerSend";
import { useComposerDraftStore } from "./composerDraftStore";

export async function sourceWithCachedIcon(
  source: ComposerAppSnapSource,
): Promise<ComposerAppSnapSource> {
  const bundleIdentifier = source.bundleIdentifier?.trim() || null;
  if (!bundleIdentifier) return source;
  if (source.appIconDataUrl) {
    await persistAppSnapIcon({
      bundleIdentifier,
      dataUrl: source.appIconDataUrl,
    }).catch((error) => console.warn("[appsnap] Could not cache source app icon", error));
    return source;
  }
  const appIconDataUrl = await readAppSnapIcon(bundleIdentifier).catch((error) => {
    console.warn("[appsnap] Could not restore source app icon", error);
    return null;
  });
  return appIconDataUrl ? { ...source, appIconDataUrl } : source;
}

export async function insertAppSnapCaptureIntoDraft(
  threadId: ThreadId,
  capture: DesktopAppSnapCapture,
): Promise<"persisted" | "unverified"> {
  const parsedCaptureAt = Date.parse(capture.capturedAt);
  const captureAtMs = Number.isFinite(parsedCaptureAt) ? parsedCaptureAt : Date.now();
  const bytes = new Uint8Array(capture.bytes);
  if (bytes.byteLength === 0) throw new Error("The captured AppSnap is empty.");
  const file = new File([bytes], capture.name, {
    type: capture.mimeType,
    lastModified: captureAtMs,
  });
  const draftStore = useComposerDraftStore.getState();
  const draft = draftStore.draftsByThreadId[threadId];
  const existingAttachmentCount = effectiveComposerAttachmentCount(draft);
  const { images, error } = await prepareComposerImageAttachmentsFromFiles({
    files: [file],
    existingAttachmentCount,
  });
  const image = images[0];
  if (!image) throw new Error(error ?? "Synara could not attach the captured AppSnap.");

  let imageAddedToDraft = false;
  let blobKey: string | null = null;
  let persistenceResult: "persisted" | "unverified" = "persisted";
  try {
    const source: ComposerAppSnapSource = {
      kind: "appsnap",
      captureId: capture.id,
      capturedAt: capture.capturedAt,
      appName: capture.sourceAppName,
      bundleIdentifier: capture.sourceBundleIdentifier,
      appIconDataUrl: capture.sourceAppIconDataUrl,
      windowTitle: capture.sourceWindowTitle,
    };
    const sourceWithIcon = await sourceWithCachedIcon(source);
    const appSnapImage = { ...image, source: sourceWithIcon };
    // A const keeps the narrowed `string` type inside the retry closure below;
    // the outer `blobKey` stays nullable for the rollback paths.
    const persistedBlobKey = await persistComposerImageBlob({
      threadId,
      imageId: appSnapImage.id,
      file: appSnapImage.file,
    });
    blobKey = persistedBlobKey;

    if (!draftStore.addImage(threadId, appSnapImage)) {
      throw new Error(
        "The AppSnap was prepared, but this message already has the maximum number of references.",
      );
    }
    imageAddedToDraft = true;
    const syncAttachmentList = () =>
      draftStore.syncPersistedAttachments(threadId, [
        ...(useComposerDraftStore
          .getState()
          .draftsByThreadId[threadId]?.persistedAttachments?.filter(
            (attachment) => attachment.id !== appSnapImage.id,
          ) ?? []),
        {
          id: appSnapImage.id,
          name: appSnapImage.name,
          mimeType: appSnapImage.mimeType,
          sizeBytes: appSnapImage.sizeBytes,
          blobKey: persistedBlobKey,
          source: sourceWithIcon,
        },
      ]);
    let result = await syncAttachmentList();
    if (result === "rejected") {
      // Concurrent draft persistence can supersede this sync's generation;
      // a single retry lets the newest staged list settle before failing.
      result = await syncAttachmentList();
    }
    if (result === "rejected") {
      const imageStillInDraft =
        useComposerDraftStore
          .getState()
          .draftsByThreadId[threadId]?.images.some((entry) => entry.id === appSnapImage.id) ??
        false;
      if (imageStillInDraft) {
        // The chip survived; treat a transient metadata race as unverified
        // instead of deleting a capture the user can already see.
        result = "unverified";
      } else {
        draftStore.removeImage(threadId, appSnapImage.id);
        await deleteComposerImageBlob(blobKey).catch((cleanupError) =>
          console.warn("[appsnap] Could not roll back rejected capture", cleanupError),
        );
        throw new Error("The AppSnap was captured, but its draft metadata was rejected.");
      }
    }
    // Clear recalled prompt-history state only after the new attachment has
    // survived persistence verification. A rejected mutation must leave the
    // user's prior draft snapshot intact.
    draftStore.setPromptHistorySavedDraft(threadId, null);
    persistenceResult = result;
  } catch (error) {
    if (!imageAddedToDraft) {
      URL.revokeObjectURL(image.previewUrl);
      if (blobKey) {
        await deleteComposerImageBlob(blobKey).catch((cleanupError) =>
          console.warn("[appsnap] Could not roll back unattached capture", cleanupError),
        );
      }
    }
    throw error;
  }
  return persistenceResult;
}
