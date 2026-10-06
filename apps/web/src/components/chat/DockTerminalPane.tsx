// A single terminal panel with an independent, chat-owned dock session.

import { type ProjectId, type ThreadId } from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useTerminalSurfaceController } from "~/hooks/useTerminalSurfaceController";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "~/lib/chatPaneScope";
import { dockTerminalThreadId } from "~/lib/dockTerminalScope";
import {
  getTerminalContextComposerTarget,
  subscribeTerminalContextComposerTarget,
} from "~/lib/terminalContextComposerRegistry";
import { useTerminalStateStore } from "~/terminalStateStore";
import { projectScriptRuntimeEnv } from "~/projectScripts";
import { useStore } from "~/store";
import { createProjectSelector, createThreadWorkspaceMetadataSelector } from "~/storeSelectors";
import ThreadTerminalDrawer from "../ThreadTerminalDrawer";

export function DockTerminalPane(props: {
  hostThreadId: ThreadId;
  paneId: string;
  projectId: ProjectId | null;
  // When false the pane stays mounted but hidden (another dock tab is active),
  // so the xterm runtime sleeps its visual work without detaching its DOM.
  isActive?: boolean;
  onClosePanel: () => void;
}) {
  const scopeId = dockTerminalThreadId(props.hostThreadId);
  const threadWorkspace = useStore(
    useMemo(() => createThreadWorkspaceMetadataSelector(props.hostThreadId), [props.hostThreadId]),
  );
  const project = useStore(
    useMemo(() => createProjectSelector(props.projectId), [props.projectId]),
  );
  const worktreePath = threadWorkspace.worktreePath;
  const workingDirectory = threadWorkspace.workingDirectory;
  const projectCwd = project?.cwd ?? null;
  const cwd =
    resolveThreadWorkspaceCwd({
      projectCwd,
      envMode: threadWorkspace.envMode,
      worktreePath,
      workingDirectory,
    }) ?? "";
  const runtimeProjectCwd = workingDirectory ?? projectCwd;
  const runtimeEnv = runtimeProjectCwd
    ? projectScriptRuntimeEnv({ project: { cwd: runtimeProjectCwd }, worktreePath })
    : {};

  const terminal = useTerminalSurfaceController(scopeId);
  const { terminalState } = terminal;
  const ensureDockTerminal = useTerminalStateStore((state) => state.ensureDockTerminal);
  const terminalId = terminalState.dockTerminalIdsByPaneId?.[props.paneId];
  const initializedPaneRef = useRef<string | null>(null);
  const setActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const subscribeToComposerTarget = useCallback(
    (listener: () => void) =>
      subscribeTerminalContextComposerTarget(SINGLE_CHAT_PANE_SCOPE_ID, listener),
    [],
  );
  const readComposerTarget = useCallback(
    () => getTerminalContextComposerTarget(SINGLE_CHAT_PANE_SCOPE_ID),
    [],
  );
  const composerTarget = useSyncExternalStore(
    subscribeToComposerTarget,
    readComposerTarget,
    readComposerTarget,
  );

  // Ensure a session only on first mount of this scope. Explicit close and shell
  // exit must not race an effect that creates a replacement behind the panel.
  useEffect(() => {
    const paneKey = `${scopeId}:${props.paneId}`;
    if (initializedPaneRef.current === paneKey) return;
    initializedPaneRef.current = paneKey;
    ensureDockTerminal(scopeId, props.paneId);
  }, [ensureDockTerminal, props.paneId, scopeId]);

  useEffect(() => {
    if (terminalId && (props.isActive ?? true)) setActiveTerminal(scopeId, terminalId);
  }, [props.isActive, scopeId, setActiveTerminal, terminalId]);

  const onSessionExited = (terminalId: string) => {
    const disposition = terminal.handleDockTerminalSessionExited(terminalId);
    if (disposition !== "ignored") {
      props.onClosePanel();
    }
  };

  if (!terminalId) return null;

  return (
    <ThreadTerminalDrawer
      key={scopeId}
      threadId={scopeId}
      cwd={cwd}
      runtimeEnv={runtimeEnv}
      isVisible={props.isActive ?? true}
      terminalLabelsById={terminalState.terminalLabelsById}
      terminalTitleOverridesById={terminalState.terminalTitleOverridesById}
      terminalCliKindsById={terminalState.terminalCliKindsById}
      activeTerminalId={terminalId}
      focusRequestId={terminal.focusRequestId}
      onTerminalSessionExited={onSessionExited}
      onTerminalMetadataChange={terminal.setTerminalMetadata}
      onTerminalActivityChange={terminal.setTerminalActivity}
      onAddTerminalContext={composerTarget}
    />
  );
}

export default DockTerminalPane;
