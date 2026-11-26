import type { ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, type ReactNode } from "react";
import { requestComposerFocus } from "~/composerFocusRequestStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useTranslation } from "~/i18n";
import { useRightDockStore } from "~/rightDockStore";
import type { RightDockPane } from "~/rightDockStore.logic";
import { routeSingleDockPaneOpenRequest } from "../chat/dockPaneOpenRequest";
import { resolveRightDockPaneIcon } from "../chat/rightDockPaneMeta";
import { CanvasAgentIconSlot } from "./editor/CanvasAgentActivity";
import {
  useActiveAgentPages,
  useCanvasPaneRequestStore,
  type CanvasPaneOpenRequest,
} from "./canvasStores";
import { canvasWorkQueryOptions } from "./canvasWorkCache";
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
 * After the title and page in both layouts' headers: why the canvas will not change right now
 * (updates unavailable while the connection is down; an archived work is read only).
 */
export function CanvasHeaderStatus({
  readOnly,
  connection,
}: {
  readOnly: boolean;
  connection: ReturnType<typeof useCanvasLibrary>;
}) {
  const { t } = useTranslation();
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
