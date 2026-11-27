import type { ThreadId } from "@synara/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useSyncExternalStore, type ReactNode } from "react";
import { requestComposerFocus } from "~/composerFocusRequestStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useTranslation } from "~/i18n";
import { showUndoToast } from "~/lib/threadUndoToast";
import { randomUUID } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useRightDockStore } from "~/rightDockStore";
import type { RightDockPane } from "~/rightDockStore.logic";
import { routeSingleDockPaneOpenRequest } from "../chat/dockPaneOpenRequest";
import { resolveRightDockPaneIcon } from "../chat/rightDockPaneMeta";
import { toastManager } from "../ui/toast";
import { CanvasAgentIconSlot } from "./editor/CanvasAgentActivity";
import {
  useActiveAgentPages,
  useCanvasPaneRequestStore,
  type CanvasPaneOpenRequest,
} from "./canvasStores";
import {
  canvasQueryKey,
  canvasWorkQueryOptions,
  canvasWritesInFlight,
  subscribeCanvasWrites,
} from "./canvasWorkCache";
import { useCanvasLibrary } from "./useCanvasLibrary";

/** Opens a work in a chat's right dock, next to that chat. */
export function openCanvasPane(threadId: ThreadId, workId: string, pageId?: string | null) {
  useRightDockStore
    .getState()
    .openPane(threadId, { kind: "canvas", canvasWorkId: workId, canvasPageId: pageId ?? null });
}

/**
 * Shows the canvas an agent works on beside the chat that writes it, through the dock's one
 * routing rule for agent-triggered panes (dockPaneOpenRequest.ts): the pane is remembered on
 * that chat's dock, only the chat on screen is hydrated, and focus stays where it is.
 */
export function openCanvasPaneForAgent(input: {
  currentThreadId: ThreadId;
  request: CanvasPaneOpenRequest;
  requestImmediateHydration: () => void;
}) {
  const { request } = input;
  routeSingleDockPaneOpenRequest({
    currentThreadId: input.currentThreadId,
    requestedThreadId: request.threadId,
    requestImmediateHydration: input.requestImmediateHydration,
    openPane: (threadId) => openCanvasPane(threadId, request.workId, request.pageId),
  });
}

/**
 * Delivers the canvas panes agent work asked for to a chat surface, like the device pane's
 * requests: they wait in the store until a surface can show them, and each is taken once.
 */
export function useCanvasPaneOpenRequests(input: {
  /** Null where the surface cannot host a canvas pane. */
  readonly onOpenPaneRequested: ((request: CanvasPaneOpenRequest) => void) | null;
}): void {
  const pending = useCanvasPaneRequestStore((store) => store.pending);
  const openEnabled = input.onOpenPaneRequested !== null;
  const deliverPendingRequests = useEffectEvent(() => {
    const onOpen = input.onOpenPaneRequested;
    if (!onOpen) return;
    for (const request of useCanvasPaneRequestStore.getState().take()) onOpen(request);
  });
  useEffect(() => {
    if (openEnabled && pending.length > 0) deliverPendingRequests();
  }, [openEnabled, pending]);
}

/** The canvas tab's glyph, handing its place to the agent indicator while an agent works there. */
function CanvasDockTabIcon({ workId, icon }: { workId: string; icon: ReactNode }) {
  const working = useActiveAgentPages(workId).size > 0;
  return <CanvasAgentIconSlot active={working} scope="work" icon={icon} />;
}

/**
 * Dock tab icons for a chat's panes (the dock's `paneIconOverrides`): the canvas tab shows the
 * agent indicator while an agent works on any page of the work in that pane, so it shows from
 * behind another tab too. Idle, the tab keeps its usual glyph.
 */
export function canvasDockPaneIcons(
  panes: readonly RightDockPane[],
): Record<string, ReactNode> | undefined {
  const pane = panes.find((item) => item.kind === "canvas" && item.canvasWorkId);
  if (!pane?.canvasWorkId) return undefined;
  return {
    [pane.id]: (
      <CanvasDockTabIcon workId={pane.canvasWorkId} icon={resolveRightDockPaneIcon(pane)} />
    ),
  };
}

/** Seeds a chat's composer with a canvas request and focuses it; the user sends it. */
export function askInChat(threadId: ThreadId, prompt: string) {
  const store = useComposerDraftStore.getState();
  const current = store.draftsByThreadId?.[threadId]?.prompt?.trim();
  store.setPrompt(threadId, current ? `${current}\n\n${prompt}` : prompt);
  requestComposerFocus(threadId);
}

export function useCanvasWork(workId: string) {
  const connection = useCanvasLibrary();
  const query = useQuery({ ...canvasWorkQueryOptions(workId), enabled: connection.supported });
  return { connection, query };
}

/**
 * After the archive of a work or folder: the app's compact Undo toast, as archiving a chat shows.
 * Undo restores it; a failed restore is reported and the toast stays.
 */
export function showCanvasArchiveUndo(
  client: QueryClient,
  input: { id: string; message: string; failedTitle: string },
) {
  showUndoToast(`canvas-archive-undo:${input.id}:${randomUUID()}`, {
    message: input.message,
    onUndo: async () => {
      try {
        await ensureNativeApi().canvas.update({ id: input.id, archived: false });
        // The library lists and this work; other cached works are unchanged.
        await client.invalidateQueries({
          queryKey: canvasQueryKey,
          predicate: (query) => query.queryKey[1] !== "work" || query.queryKey[2] === input.id,
        });
        return true;
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: input.failedTitle,
          description: cause instanceof Error ? cause.message : undefined,
        });
        return false;
      }
    },
  });
}

/** Writes pending this long show "Saving…", so quick ones never flicker in the header. */
export const CANVAS_SAVING_DELAY_MS = 400;

/**
 * Whether this client's writes to the work are pending: "saving" once they have been for a
 * moment (until a moment after they settle), "unsaved" while the connection is down. The
 * transport holds a write made while disconnected and sends it once the connection is back
 * (within the request's 60 s deadline; after that it fails with the editor's error toast).
 */
export function useCanvasSaveState(
  workId: string,
  disconnected: boolean,
): "saving" | "unsaved" | null {
  const client = useQueryClient();
  const pending = useSyncExternalStore(
    subscribeCanvasWrites,
    () => canvasWritesInFlight(client, workId) > 0,
  );
  const [saving] = useDebouncedValue(pending, { wait: CANVAS_SAVING_DELAY_MS });
  if (pending && disconnected) return "unsaved";
  return saving ? "saving" : null;
}

/**
 * After the title and page in both layouts' headers: whether the work's changes are saved
 * ("Saving…", or "Unsaved changes" while they wait for the connection, the file editor's
 * wording) and why the canvas will not change right now (updates unavailable while the
 * connection is down; an archived work is read only).
 */
export function CanvasHeaderStatus({
  workId,
  readOnly,
  connection,
}: {
  workId: string;
  readOnly: boolean;
  connection: ReturnType<typeof useCanvasLibrary>;
}) {
  const { t } = useTranslation();
  const saveState = useCanvasSaveState(workId, connection.disconnected);
  return (
    <>
      {connection.disconnected && (
        <span
          role="status"
          data-canvas-header-status="disconnected"
          title={t("workspace:designSyncFailed")}
          className="min-w-0 truncate ps-1 text-ui-xs text-muted-foreground"
        >
          {t("workspace:designSyncFailed")}
        </span>
      )}
      {saveState && (
        <span
          role="status"
          data-canvas-header-status={saveState}
          className="shrink-0 ps-1 text-ui-xs text-muted-foreground"
        >
          {saveState === "unsaved" ? t("workspace:unsavedChanges") : t("common:saving2")}
        </span>
      )}
      {readOnly && (
        <span
          data-canvas-header-status="archived"
          className="shrink-0 ps-1 text-ui-xs text-muted-foreground"
        >
          {t("workspace:canvasArchived")}
        </span>
      )}
    </>
  );
}

export function CanvasStatus({
  connection,
  error,
}: {
  connection: ReturnType<typeof useCanvasLibrary>;
  error: boolean;
}) {
  const { t } = useTranslation();
  return (
    <p className="m-auto p-6 text-center text-ui text-muted-foreground" role="status">
      {error
        ? t("workspace:designLoadFailed")
        : !connection.negotiating && !connection.supported
          ? t("workspace:canvasHostUnavailable")
          : t("workspace:designLoading")}
    </p>
  );
}
