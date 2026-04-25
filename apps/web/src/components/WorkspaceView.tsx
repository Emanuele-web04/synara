// FILE: WorkspaceView.tsx
// Purpose: Render a dedicated terminal-only workspace page backed by a synthetic terminal scope.
// Layer: Workspace route surface

import { Plus, SettingsIcon } from "~/lib/icons";
import { type TerminalCliKind } from "@t3tools/shared/terminalThreads";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { readNativeApi } from "~/nativeApi";
import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import {
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
} from "~/lib/terminalCloseConfirmation";
import { resolveTerminalNewAction } from "~/lib/terminalNewAction";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { selectThreadTerminalState, useTerminalStateStore } from "~/terminalStateStore";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import WorkspaceSettingsSheet from "./WorkspaceSettingsSheet";
import { onServerWelcome } from "~/wsNativeApi";
import { useWorkspaceStore, workspaceThreadId } from "~/workspaceStore";
import {
  DEFAULT_WORKSPACE_LAYOUT_PRESET_ID,
  ensureTerminalIdsForPreset,
  type WorkspaceLayoutPresetId,
} from "~/workspaceTerminalLayoutPresets";
import { terminalRuntimeRegistry } from "./terminal/terminalRuntimeRegistry";

function randomTerminalId(): string {
  if (typeof crypto.randomUUID === "function") {
    return `terminal-${crypto.randomUUID()}`;
  }
  return `terminal-${Math.random().toString(36).slice(2, 10)}`;
}

export default function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const { settings } = useAppSettings();
  const workspace = useWorkspaceStore((state) =>
    state.workspacePages.find((entry) => entry.id === workspaceId),
  );
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const ensureWorkspacePage = useWorkspaceStore((state) => state.ensureWorkspacePage);
  const renameWorkspace = useWorkspaceStore((state) => state.renameWorkspace);
  const setWorkspaceLayoutPreset = useWorkspaceStore((state) => state.setWorkspaceLayoutPreset);
  const setWorkspaceHomeDir = useWorkspaceStore((state) => state.setHomeDir);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const threadId = useMemo(() => workspaceThreadId(workspaceId), [workspaceId]);
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);
  const setTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const setTerminalMetadata = useTerminalStateStore((state) => state.setTerminalMetadata);
  const splitTerminalRight = useTerminalStateStore((state) => state.splitTerminalRight);
  const splitTerminalDown = useTerminalStateStore((state) => state.splitTerminalDown);
  const newTerminal = useTerminalStateStore((state) => state.newTerminal);
  const newTerminalTab = useTerminalStateStore((state) => state.newTerminalTab);
  const setActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const closeTerminalState = useTerminalStateStore((state) => state.closeTerminal);
  const closeTerminalGroup = useTerminalStateStore((state) => state.closeTerminalGroup);
  const resizeTerminalSplit = useTerminalStateStore((state) => state.resizeTerminalSplit);
  const setTerminalActivity = useTerminalStateStore((state) => state.setTerminalActivity);
  const applyWorkspaceLayoutPreset = useTerminalStateStore(
    (state) => state.applyWorkspaceLayoutPreset,
  );
  const bootstrappedWorkspaceRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(workspace?.title ?? "Workspace");
  const workspaceLayoutPresetId = workspace?.layoutPresetId ?? DEFAULT_WORKSPACE_LAYOUT_PRESET_ID;

  useEffect(() => {
    ensureWorkspacePage(workspaceId);
  }, [ensureWorkspacePage, workspaceId]);

  useEffect(
    () => onServerWelcome((payload) => setWorkspaceHomeDir(payload.homeDir)),
    [setWorkspaceHomeDir],
  );

  useEffect(() => {
    if (!serverConfigQuery.data?.homeDir) {
      return;
    }
    setWorkspaceHomeDir(serverConfigQuery.data.homeDir);
  }, [serverConfigQuery.data?.homeDir, setWorkspaceHomeDir]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    setDraftTitle(workspace.title);
  }, [workspace]);

  useEffect(() => {
    if (!renaming) {
      return;
    }
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    bootstrappedWorkspaceRef.current = false;
  }, [workspaceId]);

  useEffect(() => {
    if (bootstrappedWorkspaceRef.current || !homeDir || terminalState.terminalOpen) {
      return;
    }
    bootstrappedWorkspaceRef.current = true;
    const nextTerminalIds = ensureTerminalIdsForPreset(
      terminalState.terminalIds,
      workspaceLayoutPresetId,
      randomTerminalId,
    );
    applyWorkspaceLayoutPreset(threadId, workspaceLayoutPresetId, nextTerminalIds);
    openTerminalThreadPage(threadId, { terminalOnly: true });
  }, [
    applyWorkspaceLayoutPreset,
    homeDir,
    openTerminalThreadPage,
    terminalState.terminalIds,
    terminalState.terminalOpen,
    threadId,
    workspaceLayoutPresetId,
  ]);

  const commitRename = useCallback(() => {
    if (!workspace) {
      setRenaming(false);
      return;
    }
    renameWorkspace(workspace.id, draftTitle);
    setRenaming(false);
  }, [draftTitle, renameWorkspace, workspace]);

  const restoreTerminalWorkspace = useCallback(
    (presetId: WorkspaceLayoutPresetId = workspaceLayoutPresetId) => {
      const nextTerminalIds = ensureTerminalIdsForPreset(
        terminalState.terminalIds,
        presetId,
        randomTerminalId,
      );
      applyWorkspaceLayoutPreset(threadId, presetId, nextTerminalIds);
      openTerminalThreadPage(threadId, { terminalOnly: true });
      setFocusRequestId((value) => value + 1);
    },
    [
      applyWorkspaceLayoutPreset,
      openTerminalThreadPage,
      terminalState.terminalIds,
      threadId,
      workspaceLayoutPresetId,
    ],
  );

  const applyWorkspacePresetSelection = useCallback(
    (presetId: WorkspaceLayoutPresetId) => {
      if (!workspace) {
        return;
      }
      setWorkspaceLayoutPreset(workspace.id, presetId);
      const nextTerminalIds = ensureTerminalIdsForPreset(
        terminalState.terminalIds,
        presetId,
        randomTerminalId,
      );
      applyWorkspaceLayoutPreset(threadId, presetId, nextTerminalIds);
      openTerminalThreadPage(threadId, { terminalOnly: true });
      setFocusRequestId((value) => value + 1);
    },
    [
      applyWorkspaceLayoutPreset,
      openTerminalThreadPage,
      setWorkspaceLayoutPreset,
      terminalState.terminalIds,
      threadId,
      workspace,
    ],
  );

  const createWorkspaceTerminal = useCallback(() => {
    if (!terminalState.terminalOpen) {
      restoreTerminalWorkspace();
      return;
    }
    const terminalId = randomTerminalId();
    newTerminal(threadId, terminalId);
    setFocusRequestId((value) => value + 1);
  }, [newTerminal, restoreTerminalWorkspace, terminalState.terminalOpen, threadId]);

  const splitWorkspaceTerminalRight = useCallback(() => {
    const terminalId = randomTerminalId();
    splitTerminalRight(threadId, terminalId);
    setFocusRequestId((value) => value + 1);
  }, [splitTerminalRight, threadId]);

  const splitWorkspaceTerminalDown = useCallback(() => {
    const terminalId = randomTerminalId();
    splitTerminalDown(threadId, terminalId);
    setFocusRequestId((value) => value + 1);
  }, [splitTerminalDown, threadId]);

  const createWorkspaceTerminalTab = useCallback(
    (targetTerminalId: string) => {
      const terminalId = randomTerminalId();
      newTerminalTab(threadId, targetTerminalId, terminalId);
      setFocusRequestId((value) => value + 1);
    },
    [newTerminalTab, threadId],
  );
  const createWorkspaceTerminalFromShortcut = useCallback(() => {
    const action = resolveTerminalNewAction({
      terminalOpen: terminalState.terminalOpen,
      activeTerminalId: terminalState.activeTerminalId,
      activeTerminalGroupId: terminalState.activeTerminalGroupId,
      terminalGroups: terminalState.terminalGroups,
    });

    if (action.kind === "new-group") {
      createWorkspaceTerminal();
      return;
    }

    createWorkspaceTerminalTab(action.targetTerminalId);
  }, [
    createWorkspaceTerminal,
    createWorkspaceTerminalTab,
    terminalState.activeTerminalGroupId,
    terminalState.activeTerminalId,
    terminalState.terminalGroups,
    terminalState.terminalOpen,
  ]);

  const moveTerminalToNewGroup = useCallback(
    (terminalId: string) => {
      newTerminal(threadId, terminalId);
      setFocusRequestId((value) => value + 1);
    },
    [newTerminal, threadId],
  );

  const activateTerminal = useCallback(
    (terminalId: string) => {
      setActiveTerminal(threadId, terminalId);
      setFocusRequestId((value) => value + 1);
    },
    [setActiveTerminal, threadId],
  );

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "new-terminal-tab") return;
      createWorkspaceTerminalFromShortcut();
    });

    return () => {
      unsubscribe?.();
    };
  }, [createWorkspaceTerminalFromShortcut]);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const api = readNativeApi();
      const confirmed = await confirmTerminalTabClose({
        api,
        enabled: settings.confirmTerminalTabClose,
        terminalTitle: resolveTerminalCloseTitle({
          terminalId,
          terminalLabelsById: terminalState.terminalLabelsById,
          terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
        }),
      });
      if (!confirmed) {
        return;
      }
      terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);
      const fallbackExitWrite = () =>
        api?.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);

      if (api && "close" in api.terminal && typeof api.terminal.close === "function") {
        void api.terminal
          .close({
            threadId,
            terminalId,
            deleteHistory: true,
          })
          .catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      closeTerminalState(threadId, terminalId);
      setFocusRequestId((value) => value + 1);
    },
    [
      closeTerminalState,
      settings.confirmTerminalTabClose,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
      threadId,
    ],
  );

  const terminalDrawerProps = useMemo(
    () => ({
      threadId,
      cwd: homeDir ?? "",
      height: terminalState.terminalHeight,
      terminalIds: terminalState.terminalIds,
      terminalLabelsById: terminalState.terminalLabelsById,
      terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
      terminalCliKindsById: terminalState.terminalCliKindsById,
      terminalAttentionStatesById: terminalState.terminalAttentionStatesById ?? {},
      runningTerminalIds: terminalState.runningTerminalIds,
      activeTerminalId: terminalState.activeTerminalId,
      terminalGroups: terminalState.terminalGroups,
      activeTerminalGroupId: terminalState.activeTerminalGroupId,
      focusRequestId,
      onSplitTerminal: splitWorkspaceTerminalRight,
      onSplitTerminalDown: splitWorkspaceTerminalDown,
      onNewTerminal: createWorkspaceTerminal,
      onNewTerminalTab: createWorkspaceTerminalTab,
      onMoveTerminalToGroup: moveTerminalToNewGroup,
      onActiveTerminalChange: activateTerminal,
      onCloseTerminal: closeTerminal,
      onCloseTerminalGroup: (groupId: string) => {
        closeTerminalGroup(threadId, groupId);
      },
      onHeightChange: (height: number) => {
        setTerminalHeight(threadId, height);
      },
      onResizeTerminalSplit: (groupId: string, splitId: string, weights: number[]) => {
        resizeTerminalSplit(threadId, groupId, splitId, weights);
      },
      onTerminalMetadataChange: (
        terminalId: string,
        metadata: { cliKind: TerminalCliKind | null; label: string },
      ) => {
        setTerminalMetadata(threadId, terminalId, metadata);
      },
      onTerminalActivityChange: (
        terminalId: string,
        activity: {
          hasRunningSubprocess: boolean;
          agentState: "running" | "attention" | "review" | null;
        },
      ) => {
        setTerminalActivity(threadId, terminalId, activity);
      },
      onAddTerminalContext: () => {},
    }),
    [
      activateTerminal,
      closeTerminal,
      closeTerminalGroup,
      createWorkspaceTerminal,
      createWorkspaceTerminalTab,
      focusRequestId,
      homeDir,
      moveTerminalToNewGroup,
      resizeTerminalSplit,
      setTerminalActivity,
      setTerminalHeight,
      setTerminalMetadata,
      splitWorkspaceTerminalDown,
      splitWorkspaceTerminalRight,
      terminalState.activeTerminalGroupId,
      terminalState.activeTerminalId,
      terminalState.terminalAttentionStatesById,
      terminalState.runningTerminalIds,
      terminalState.terminalCliKindsById,
      terminalState.terminalGroups,
      terminalState.terminalHeight,
      terminalState.terminalIds,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
      threadId,
    ],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="border-b border-border px-3 sm:px-5">
          <div className="flex h-[52px] items-center gap-2 sm:gap-3">
            <SidebarHeaderNavigationControls />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {renaming ? (
                <input
                  ref={renameInputRef}
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDraftTitle(workspace?.title ?? "Workspace");
                      setRenaming(false);
                    }
                  }}
                  className="h-7 max-w-[16rem] rounded-md border border-border bg-background px-2 text-sm font-medium outline-none focus:border-ring"
                />
              ) : (
                <h2
                  className="max-w-[clamp(16rem,50vw,40rem)] cursor-default truncate text-sm font-medium text-foreground"
                  title="Double-click to rename"
                  onDoubleClick={() => setRenaming(true)}
                >
                  {workspace?.title ?? "Workspace"}
                </h2>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
              <Button
                size="xs"
                variant="outline"
                className="gap-1.5"
                onClick={createWorkspaceTerminal}
              >
                <Plus className="size-3" />
                <span className="hidden sm:inline">Terminal</span>
              </Button>
              <Button
                size="icon-xs"
                variant="outline"
                onClick={() => setSettingsOpen(true)}
                aria-label="Workspace settings"
              >
                <SettingsIcon className="size-3" />
              </Button>
            </div>
          </div>
        </header>

        <div className="min-h-0 min-w-0 flex-1">
          {!homeDir ? (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-sm text-center">
                <div className="text-sm font-medium text-foreground/85">Loading workspace</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Waiting for the renderer to resolve your home directory.
                </div>
              </div>
            </div>
          ) : terminalState.terminalOpen ? (
            <ThreadTerminalDrawer
              key={`${workspaceId}-workspace`}
              {...terminalDrawerProps}
              presentationMode="workspace"
              isVisible
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-sm rounded-3xl border border-border/70 bg-card/40 p-6 text-center shadow-sm">
                <div className="text-base font-medium text-foreground/88">
                  This workspace has no open terminals
                </div>
                <div className="mt-2 text-sm leading-6 text-muted-foreground">
                  Open a fresh terminal rooted in your home directory and start from there.
                </div>
                <div className="mt-5">
                  <Button onClick={() => restoreTerminalWorkspace()}>
                    <Plus className="size-4" />
                    New terminal
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <WorkspaceSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        selectedPresetId={workspaceLayoutPresetId}
        onSelectPreset={applyWorkspacePresetSelection}
        workspaceTitle={workspace?.title ?? "Workspace"}
      />
    </SidebarInset>
  );
}
