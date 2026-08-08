import type { ProviderKind } from "@synara/contracts";
import { useEffect, useRef } from "react";

import ThreadTerminalDrawer from "~/components/ThreadTerminalDrawer";
import { useTerminalSurfaceController } from "~/hooks/useTerminalSurfaceController";
import { readNativeApi } from "~/nativeApi";
import { runProjectCommandInTerminal } from "~/projectTerminalRunner";
import { onboardingTerminalThreadId } from "../onboardingTerminalScope";

const CONNECT_TERMINAL_HEIGHT = 280;

export function ProviderConnectTerminal(props: {
  provider: ProviderKind;
  signInCommand: string;
  cwd: string;
}) {
  const scopeId = onboardingTerminalThreadId(props.provider);
  const terminal = useTerminalSurfaceController(scopeId);
  const { terminalState, openTerminalThreadPage } = terminal;

  useEffect(() => {
    if (terminalState.terminalOpen) {
      return;
    }
    openTerminalThreadPage(scopeId, { terminalOnly: true });
  }, [openTerminalThreadPage, scopeId, terminalState.terminalOpen]);

  const commandStartedRef = useRef(false);
  const activeTerminalId = terminalState.activeTerminalId || terminalState.terminalIds[0];
  useEffect(() => {
    if (commandStartedRef.current || !terminalState.terminalOpen || !activeTerminalId) {
      return;
    }
    const api = readNativeApi();
    if (!api || props.cwd.length === 0) {
      return;
    }
    commandStartedRef.current = true;
    void runProjectCommandInTerminal({
      api,
      threadId: scopeId,
      terminalId: activeTerminalId,
      project: { cwd: props.cwd },
      cwd: props.cwd,
      command: props.signInCommand,
    }).catch(() => {
      commandStartedRef.current = false;
    });
  }, [activeTerminalId, props.cwd, props.signInCommand, scopeId, terminalState.terminalOpen]);

  return (
    <div className="overflow-hidden rounded-lg border border-border/70">
      <ThreadTerminalDrawer
        key={scopeId}
        threadId={scopeId}
        cwd={props.cwd}
        runtimeEnv={{}}
        height={CONNECT_TERMINAL_HEIGHT}
        presentationMode="workspace"
        isVisible
        terminalIds={terminalState.terminalIds}
        terminalLabelsById={terminalState.terminalLabelsById}
        terminalTitleOverridesById={terminalState.terminalTitleOverridesById}
        terminalCliKindsById={terminalState.terminalCliKindsById}
        terminalAttentionStatesById={terminalState.terminalAttentionStatesById ?? {}}
        runningTerminalIds={terminalState.runningTerminalIds}
        activeTerminalId={terminalState.activeTerminalId}
        terminalGroups={terminalState.terminalGroups}
        activeTerminalGroupId={terminalState.activeTerminalGroupId}
        focusRequestId={terminal.focusRequestId}
        onSplitTerminal={terminal.splitRight}
        onSplitTerminalDown={terminal.splitDown}
        onNewTerminal={terminal.newTerminalGroup}
        onNewTerminalTab={terminal.createTerminalTab}
        onMoveTerminalToGroup={terminal.moveTerminalToNewGroup}
        onActiveTerminalChange={terminal.activateTerminal}
        onCloseTerminal={terminal.closeTerminal}
        onTerminalSessionExited={terminal.handleTerminalSessionExited}
        onCloseTerminalGroup={terminal.closeTerminalGroup}
        onHeightChange={terminal.setTerminalHeight}
        onResizeTerminalSplit={terminal.resizeTerminalSplit}
        onTerminalMetadataChange={terminal.setTerminalMetadata}
        onTerminalActivityChange={terminal.setTerminalActivity}
      />
    </div>
  );
}
