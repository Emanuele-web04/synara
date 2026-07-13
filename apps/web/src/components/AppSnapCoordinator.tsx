// FILE: AppSnapCoordinator.tsx
// Purpose: Routes native macOS AppSnaps into the correct Synara composer draft.
// Layer: Root web coordinator
// Depends on: Desktop bridge, focused chat context, and existing composer attachment intake.

import { type DesktopAppSnapCapture, type ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { useAppSettings } from "../appSettings";
import {
  type AppSnapThreadTarget,
  type TimedAppSnapThreadTarget,
  hasPersistedAppSnapCapture,
  persistedAppSnapCaptureBlobKeys,
  resolveAppSnapTarget,
} from "../appSnap.logic";
import {
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  isComposerImageBlobReferenced,
  useComposerDraftStore,
} from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { useFocusedChatContext } from "../focusedChatContext";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { buildComposerImageAttachmentsFromFiles } from "../lib/composerSend";
import {
  deleteComposerImageBlob,
  deleteOrphanedComposerImageBlobs,
  persistComposerImageBlob,
  readComposerImageBlob,
} from "../lib/composerImageBlobStore";
import { persistAppSnapIcon, readAppSnapIcon } from "../lib/appSnapIconStore";
import { playAppSnapCaptureSound } from "../lib/appSnapSound";
import type { ComposerAppSnapSource } from "../lib/composerImageSource";
import { resolveRecentThreadSplitActivation } from "../recentViewActivation.logic";
import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";

const MAX_REMEMBERED_CAPTURE_IDS = 100;

interface PersistedAppSnapHydrationTarget {
  attachments: ReadonlyArray<PersistedComposerImageAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  hasAttachment: (attachmentId: string) => boolean;
  addImage: (image: ComposerImageAttachment) => void;
  removeAttachment: (attachmentId: string) => Promise<unknown>;
}

function captureTimestampMs(capture: DesktopAppSnapCapture): number {
  const parsed = Date.parse(capture.capturedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isThreadAvailable(threadId: ThreadId): boolean {
  const state = useStore.getState();
  if (state.sidebarThreadSummaryById[threadId]) return true;
  if (state.threads.some((thread) => thread.id === threadId)) return true;
  return Boolean(useComposerDraftStore.getState().draftThreadsByThreadId[threadId]);
}

// A failed attach attempt can leave a live image in a draft (for example when
// the metadata sync throws after the image was added). Remove those leftovers
// before re-attaching so a retry never produces duplicate attachments.
function removeStaleLiveCaptureImages(captureId: string): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [threadId, draft] of Object.entries(draftStore.draftsByThreadId)) {
    for (const image of draft.images) {
      if (image.source?.kind === "appsnap" && image.source.captureId === captureId) {
        draftStore.removeImage(threadId as ThreadId, image.id);
      }
    }
  }
}

function rememberCaptureId(captureIds: Map<string, true>, captureId: string): boolean {
  if (captureIds.has(captureId)) return false;
  captureIds.set(captureId, true);
  while (captureIds.size > MAX_REMEMBERED_CAPTURE_IDS) {
    const oldest = captureIds.keys().next().value as string | undefined;
    if (!oldest) break;
    captureIds.delete(oldest);
  }
  return true;
}

async function sourceWithCachedIcon(source: ComposerAppSnapSource): Promise<ComposerAppSnapSource> {
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

export function AppSnapCoordinator() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const { handleNewChat } = useHandleNewChat();
  const { focusedThreadId, splitView } = useFocusedChatContext();
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const focusedTargetRef = useRef<AppSnapThreadTarget | null>(null);
  const lastInteractionRef = useRef<TimedAppSnapThreadTarget | null>(null);
  const lastAppSnapRef = useRef<TimedAppSnapThreadTarget | null>(null);
  const captureIdsRef = useRef(new Map<string, true>());
  const captureQueueRef = useRef<Promise<void>>(Promise.resolve());
  const blobHydrationInFlightRef = useRef(new Set<string>());
  // Read through a ref so toggling the sound preference doesn't resubscribe the
  // capture listener (which would re-deliver pending captures).
  const playCaptureSoundRef = useRef(settings.appSnapPlaySound);
  playCaptureSoundRef.current = settings.appSnapPlaySound;

  useEffect(() => {
    let disposed = false;

    const hydratePersistedAppSnaps = async () => {
      const draftStore = useComposerDraftStore.getState();
      for (const [rawThreadId, draft] of Object.entries(draftStore.draftsByThreadId)) {
        const threadId = rawThreadId as ThreadId;
        const targets: PersistedAppSnapHydrationTarget[] = [
          {
            attachments: draft.persistedAttachments,
            images: draft.images,
            hasAttachment: (attachmentId) =>
              useComposerDraftStore
                .getState()
                .draftsByThreadId[threadId]?.persistedAttachments.some(
                  (attachment) => attachment.id === attachmentId,
                ) ?? false,
            addImage: (image) => useComposerDraftStore.getState().addImage(threadId, image),
            removeAttachment: (attachmentId) => {
              const latestAttachments =
                useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ??
                [];
              return useComposerDraftStore.getState().syncPersistedAttachments(
                threadId,
                latestAttachments.filter((attachment) => attachment.id !== attachmentId),
              );
            },
          },
        ];
        if (draft.promptHistorySavedDraft) {
          targets.push({
            attachments: draft.promptHistorySavedDraft.persistedAttachments,
            images: draft.promptHistorySavedDraft.images,
            hasAttachment: (attachmentId) =>
              useComposerDraftStore
                .getState()
                .draftsByThreadId[threadId]?.promptHistorySavedDraft?.persistedAttachments.some(
                  (attachment) => attachment.id === attachmentId,
                ) ?? false,
            addImage: (image) =>
              useComposerDraftStore.getState().addPromptHistorySavedDraftImage(threadId, image),
            removeAttachment: (attachmentId) => {
              const latestAttachments =
                useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft
                  ?.persistedAttachments ?? [];
              return useComposerDraftStore
                .getState()
                .syncPromptHistorySavedDraftPersistedAttachments(
                  threadId,
                  latestAttachments.filter((attachment) => attachment.id !== attachmentId),
                );
            },
          });
        }

        for (const target of targets) {
          const existingImageIds = new Set(target.images.map((image) => image.id));
          for (const attachment of target.attachments) {
            if (
              !attachment.blobKey ||
              attachment.source?.kind !== "appsnap" ||
              existingImageIds.has(attachment.id) ||
              blobHydrationInFlightRef.current.has(attachment.blobKey)
            ) {
              continue;
            }
            blobHydrationInFlightRef.current.add(attachment.blobKey);
            try {
              const [file, source] = await Promise.all([
                readComposerImageBlob(attachment.blobKey),
                sourceWithCachedIcon(attachment.source),
              ]);
              if (!file) {
                await target.removeAttachment(attachment.id);
                continue;
              }
              if (disposed || !target.hasAttachment(attachment.id)) continue;
              target.addImage({
                type: "image",
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                previewUrl: URL.createObjectURL(file),
                file,
                source,
              });
            } catch (error) {
              console.warn("[appsnap] Could not restore persisted AppSnap", error);
            } finally {
              blobHydrationInFlightRef.current.delete(attachment.blobKey);
            }
          }
        }
      }
    };

    void hydratePersistedAppSnaps().then(() => {
      if (disposed) return;
      void deleteOrphanedComposerImageBlobs({
        isReferenced: (blobKey) =>
          blobHydrationInFlightRef.current.has(blobKey) ||
          isComposerImageBlobReferenced(useComposerDraftStore.getState().draftsByThreadId, blobKey),
      }).catch((error) =>
        console.warn("[appsnap] Could not sweep orphaned composer images", error),
      );
    });
    const unsubscribe = useComposerDraftStore.subscribe((state, previousState) => {
      if (state.draftsByThreadId !== previousState.draftsByThreadId) {
        void hydratePersistedAppSnaps();
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const nextTarget = focusedThreadId
      ? {
          threadId: focusedThreadId,
          ...(splitView?.id ? { splitViewId: splitView.id } : {}),
        }
      : null;
    focusedTargetRef.current = nextTarget;
    if (nextTarget) {
      lastInteractionRef.current = { ...nextTarget, atMs: Date.now() };
    }
  }, [focusedThreadId, splitView?.id]);

  useEffect(() => {
    const recordInteraction = () => {
      const target = focusedTargetRef.current;
      if (target) lastInteractionRef.current = { ...target, atMs: Date.now() };
    };
    window.addEventListener("pointerdown", recordInteraction, { capture: true });
    window.addEventListener("keydown", recordInteraction, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", recordInteraction, { capture: true });
      window.removeEventListener("keydown", recordInteraction, { capture: true });
    };
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    void bridge.setEnabled(settings.enableAppSnap).catch((error) => {
      console.warn("[appsnap] Could not update native listener state", error);
    });
  }, [settings.enableAppSnap]);

  const activateExistingTarget = useCallback(
    async (target: AppSnapThreadTarget) => {
      openChatThreadPage(target.threadId);
      // Same thread is only "already active" when the split pane matches too;
      // a capture aimed at another pane still needs activation below.
      const focused = focusedTargetRef.current;
      if (
        focused?.threadId === target.threadId &&
        (!target.splitViewId || focused.splitViewId === target.splitViewId)
      ) {
        return;
      }

      const splitActivation = resolveRecentThreadSplitActivation({
        view: {
          kind: "thread",
          threadId: target.threadId,
          ...(target.splitViewId ? { splitViewId: target.splitViewId } : {}),
        },
        splitViewsById: useSplitViewStore.getState().splitViewsById,
      });
      if (splitActivation) {
        useSplitViewStore
          .getState()
          .setFocusedPane(splitActivation.splitViewId, splitActivation.paneId);
      }
      await navigate({
        to: "/$threadId",
        params: { threadId: target.threadId },
        search: () => (splitActivation ? { splitViewId: splitActivation.splitViewId } : {}),
      });
    },
    [navigate, openChatThreadPage],
  );

  const attachCapture = useCallback(
    async (capture: DesktopAppSnapCapture) => {
      const captureAtMs = captureTimestampMs(capture);
      const resolvedTarget = resolveAppSnapTarget({
        captureAtMs,
        lastInteraction: lastInteractionRef.current,
        lastAppSnap: lastAppSnapRef.current,
        isThreadAvailable,
      });

      let target: AppSnapThreadTarget;
      if (resolvedTarget.kind === "existing") {
        target = resolvedTarget.target;
        await activateExistingTarget(target);
      } else {
        const result = await handleNewChat({ fresh: true });
        if (!result.ok) throw new Error(result.error);
        if (!result.threadId) throw new Error("Synara could not create a task for this AppSnap.");
        target = { threadId: result.threadId };
        openChatThreadPage(target.threadId);
      }

      const bytes = new Uint8Array(capture.bytes);
      if (bytes.byteLength === 0) throw new Error("The captured AppSnap is empty.");
      const file = new File([bytes], capture.name, {
        type: capture.mimeType,
        lastModified: captureAtMs,
      });
      const draftStore = useComposerDraftStore.getState();
      const draft = draftStore.draftsByThreadId[target.threadId];
      const existingAttachmentCount =
        (draft?.images.length ?? 0) +
        (draft?.files.length ?? 0) +
        (draft?.assistantSelections.length ?? 0);
      const { images, error } = buildComposerImageAttachmentsFromFiles({
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
        blobKey = await persistComposerImageBlob({
          threadId: target.threadId,
          imageId: appSnapImage.id,
          file: appSnapImage.file,
        });

        // Match ordinary composer mutations: recalled prompt-history state no longer owns the draft.
        draftStore.setPromptHistorySavedDraft(target.threadId, null);
        draftStore.addImage(target.threadId, appSnapImage);
        imageAddedToDraft = true;
        const currentPersistedAttachments =
          useComposerDraftStore.getState().draftsByThreadId[target.threadId]
            ?.persistedAttachments ?? [];
        const result = await draftStore.syncPersistedAttachments(target.threadId, [
          ...currentPersistedAttachments.filter((attachment) => attachment.id !== appSnapImage.id),
          {
            id: appSnapImage.id,
            name: appSnapImage.name,
            mimeType: appSnapImage.mimeType,
            sizeBytes: appSnapImage.sizeBytes,
            blobKey,
            source: sourceWithIcon,
          },
        ]);
        if (result === "rejected") {
          draftStore.removeImage(target.threadId, appSnapImage.id);
          await deleteComposerImageBlob(blobKey).catch((error) =>
            console.warn("[appsnap] Could not roll back rejected capture", error),
          );
          throw new Error("The AppSnap was captured, but its draft metadata was rejected.");
        }
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
      lastAppSnapRef.current = { ...target, atMs: captureAtMs };
      requestComposerFocus(target.threadId);
      toastManager.add({
        type: persistenceResult === "unverified" ? "warning" : "success",
        title:
          persistenceResult === "unverified" ? "AppSnap added with a warning" : "AppSnap added",
        description:
          persistenceResult === "unverified"
            ? "The capture is attached, but Synara could not verify its draft metadata. If it is missing after a reload, Synara will attach it again."
            : capture.sourceAppName
              ? `Captured ${capture.sourceAppName} and added it to the composer.`
              : "The frontmost window was added to the composer.",
        data: { allowCrossThreadVisibility: true },
      });
      return persistenceResult;
    },
    [activateExistingTarget, handleNewChat, openChatThreadPage],
  );

  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    let disposed = false;

    const enqueueCapture = (capture: DesktopAppSnapCapture) => {
      if (disposed || !rememberCaptureId(captureIdsRef.current, capture.id)) return;
      captureQueueRef.current = captureQueueRef.current
        .then(async () => {
          const drafts = Object.values(useComposerDraftStore.getState().draftsByThreadId);
          if (hasPersistedAppSnapCapture(drafts, capture.id)) {
            // Draft metadata alone is not proof the screenshot survived: only
            // acknowledge (which deletes the desktop pending file) once the
            // persisted blob bytes are actually readable. Otherwise fall
            // through and attach the capture again from the pending bytes.
            const blobKeys = persistedAppSnapCaptureBlobKeys(drafts, capture.id);
            const blobs = await Promise.all(
              blobKeys.map((blobKey) => readComposerImageBlob(blobKey).catch(() => null)),
            );
            if (blobs.some((file) => file !== null)) {
              await bridge
                .acknowledgeCapture(capture.id)
                .catch((error) => console.warn("[appsnap] Could not acknowledge capture", error));
              return;
            }
          }
          let persistence: "persisted" | "unverified";
          try {
            removeStaleLiveCaptureImages(capture.id);
            persistence = await attachCapture(capture);
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "AppSnap could not be added",
              description: error instanceof Error ? error.message : "AppSnap capture failed.",
              actionProps: {
                children: "Retry",
                onClick: () => {
                  captureIdsRef.current.delete(capture.id);
                  enqueueCapture(capture);
                },
              },
              data: { allowCrossThreadVisibility: true },
            });
            return;
          }
          // An unverified draft may vanish on reload; keeping the capture
          // pending lets the next mount re-deliver it.
          if (persistence !== "persisted") return;
          await bridge
            .acknowledgeCapture(capture.id)
            .catch((error) => console.warn("[appsnap] Could not acknowledge capture", error));
        })
        .catch(() => undefined);
    };

    const unsubscribeCaptured = bridge.onCaptured((capture) => {
      // Shutter cue for live captures only; captures restored from the pending
      // store on mount happened in the past and should land silently.
      if (playCaptureSoundRef.current) void playAppSnapCaptureSound();
      enqueueCapture(capture);
    });
    const unsubscribeError = bridge.onError((error) => {
      toastManager.add({
        type: "error",
        title: "AppSnap failed",
        description: error.message,
        data: {
          allowCrossThreadVisibility: true,
          copyText: `${error.code}: ${error.message}`,
        },
      });
    });
    void bridge
      .listPendingCaptures()
      .then((captures) => captures.forEach(enqueueCapture))
      .catch((error) => console.warn("[appsnap] Could not restore pending captures", error));

    return () => {
      disposed = true;
      unsubscribeCaptured();
      unsubscribeError();
      // The dedupe map only guards a single subscription (live event vs the
      // mount-time pending replay). Keeping ids across resubscribes would make
      // the next pending replay skip captures that were never acknowledged.
      captureIdsRef.current.clear();
    };
  }, [attachCapture]);

  return null;
}
