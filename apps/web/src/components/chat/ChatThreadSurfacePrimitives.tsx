import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { ThreadId, TurnId } from "@synara/contracts";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";

import ChatView from "../ChatView";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../DiffPanelShell";
import type { DiffFileEditRequest } from "../../lib/diffEditBaseRev";
import type { SplitViewPanePanelState } from "../../splitViewStore";
import { CHAT_BACKGROUND_CLASS_NAME } from "./composerPickerStyles";
import { DelayedLoaderFade } from "./DelayedLoaderFade";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";
import { scheduleDeferredChatMount } from "./deferredChatMount";

const DiffPanel = lazy(() => import("../DiffPanel"));
export const LazyBrowserPanel = lazy(() => import("../BrowserPanel"));
export const LazyDevicePanel = lazy(() => import("../DevicePanel"));

export const noopChatSurfaceAction = () => {};

function DiffLoadingFallback(props: { mode: DiffPanelMode; hideHeader?: boolean }) {
  return (
    <DiffPanelShell
      mode={props.mode}
      header={props.hideHeader ? null : <DiffPanelHeaderSkeleton />}
    >
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
}

export function LazyDiffPanel(props: {
  mode: DiffPanelMode;
  threadId?: ThreadId | null;
  panelState?: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState?: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onClosePanel?: () => void;
  liveRefreshEnabled?: boolean;
  queriesEnabled?: boolean;
  hideHeader?: boolean;
  onRenderableFilesChange?: (files: ReadonlyArray<FileDiffMetadata>, isLoading: boolean) => void;
  onEditorDiffOptionsChange?: (control: ReactNode | null) => void;
  onVisibleFileChange?: (filePath: string | null) => void;
  onEditFile?: (request: DiffFileEditRequest) => void;
}) {
  return (
    <DiffWorkerPoolProvider>
      <Suspense
        fallback={
          <DiffLoadingFallback
            mode={props.mode}
            {...(props.hideHeader !== undefined ? { hideHeader: props.hideHeader } : {})}
          />
        }
      >
        <DiffPanel
          mode={props.mode}
          {...(props.threadId !== undefined ? { threadId: props.threadId } : {})}
          {...(props.panelState ? { panelState: props.panelState } : {})}
          {...(props.onUpdatePanelState ? { onUpdatePanelState: props.onUpdatePanelState } : {})}
          {...(props.onClosePanel ? { onClosePanel: props.onClosePanel } : {})}
          {...(props.liveRefreshEnabled !== undefined
            ? { liveRefreshEnabled: props.liveRefreshEnabled }
            : {})}
          {...(props.queriesEnabled !== undefined ? { queriesEnabled: props.queriesEnabled } : {})}
          {...(props.hideHeader !== undefined ? { hideHeader: props.hideHeader } : {})}
          {...(props.onEditFile ? { onEditFile: props.onEditFile } : {})}
          {...(props.onRenderableFilesChange
            ? { onRenderableFilesChange: props.onRenderableFilesChange }
            : {})}
          {...(props.onEditorDiffOptionsChange
            ? { onEditorDiffOptionsChange: props.onEditorDiffOptionsChange }
            : {})}
          {...(props.onVisibleFileChange ? { onVisibleFileChange: props.onVisibleFileChange } : {})}
        />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
}

export function ChatMountLoader() {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 items-center justify-center text-foreground [contain:layout_style_paint]",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      {/* The delay keeps the common fast mount (a couple of frames) from flashing a
          spinner — short waits show only the plain chat background. */}
      <DelayedLoaderFade>
        <Spinner className="size-5 text-muted-foreground" />
      </DelayedLoaderFade>
    </div>
  );
}

export function DeferredChatView(props: {
  threadId: ThreadId;
  hideHeader?: boolean;
  paneScopeId: string;
  deferMount: boolean;
  surfaceMode: "single" | "split";
  presentationMode?: "default" | "editor";
  isFocusedPane: boolean;
  panelState: SplitViewPanePanelState;
  onToggleDiff: () => void;
  onToggleRightDock?: () => void;
  onToggleBrowser: () => void;
  onToggleDevice?: () => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onSplitSurface?: () => void;
  viewModeAction?: {
    label: string;
    active: boolean;
    onClick: () => void;
  } | null;
  onCloseThreadPane?: () => void;
  onMounted?: () => void;
}) {
  const onMounted = props.onMounted ?? noopChatSurfaceAction;
  // Only defer the initial mount. Switching to another draft must not tear
  // down an already visible chat (including its tab strip) to replay the loader.
  const [mountPending, setMountPending] = useState(props.deferMount);
  if (mountPending && !props.deferMount) {
    // A saved chat reached while the initial draft is still waiting can mount
    // immediately, and subsequent drafts must not re-arm that initial delay.
    setMountPending(false);
  }
  const canMountChatView = !mountPending || !props.deferMount;

  useEffect(() => {
    if (canMountChatView) return;
    // Keep the bounded fallback for background-throttled Electron windows.
    return scheduleDeferredChatMount(window, () => setMountPending(false));
  }, [canMountChatView]);

  useEffect(() => {
    if (canMountChatView) {
      onMounted();
    }
  }, [canMountChatView, onMounted]);

  if (!canMountChatView) {
    return <ChatMountLoader />;
  }

  return (
    <ChatView
      threadId={props.threadId}
      hideHeader={props.hideHeader ?? false}
      paneScopeId={props.paneScopeId}
      surfaceMode={props.surfaceMode}
      presentationMode={props.presentationMode ?? "default"}
      isFocusedPane={props.isFocusedPane}
      panelState={props.panelState}
      onToggleDiffPanel={props.onToggleDiff}
      {...(props.onToggleRightDock ? { onToggleRightDock: props.onToggleRightDock } : {})}
      onToggleBrowserPanel={props.onToggleBrowser}
      {...(props.onToggleDevice ? { onToggleDevicePanel: props.onToggleDevice } : {})}
      onOpenBrowserUrl={props.onOpenBrowserUrl}
      onOpenTurnDiffPanel={props.onOpenTurnDiff}
      {...(props.onSplitSurface ? { onSplitSurface: props.onSplitSurface } : {})}
      {...(props.viewModeAction !== undefined ? { viewModeAction: props.viewModeAction } : {})}
      {...(props.onCloseThreadPane ? { onCloseThreadPane: props.onCloseThreadPane } : {})}
    />
  );
}
