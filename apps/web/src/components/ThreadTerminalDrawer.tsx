// One terminal viewport per chat or dock scope. The owning surface supplies its header.
import { useEffect, useRef } from "react";
import { type ThreadId } from "@synara/contracts";
import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "~/nativeApi";
import { useTerminalStateStore } from "~/terminalStateStore";
import { disposeAndCloseTerminalSession } from "./terminal/terminalSession";
import TerminalViewport from "./terminal/TerminalViewport";

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  isVisible?: boolean;
  activeTerminalId: string;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  focusRequestId: number;
  onTerminalSessionExited: (terminalId: string) => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onAddTerminalContext?: ((selection: TerminalContextSelection) => void) | undefined;
}

export default function ThreadTerminalDrawer(props: ThreadTerminalDrawerProps) {
  const { threadId, activeTerminalId } = props;
  const retiring = useRef(new Set<string>());
  const retiredTerminalIds = useTerminalStateStore(
    (state) => state.terminalStateByThreadId[threadId]?.retiredTerminalIds,
  );
  const forgetRetiredTerminal = useTerminalStateStore((state) => state.forgetRetiredTerminal);
  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    for (const terminalId of retiredTerminalIds ?? []) {
      const key = `${threadId}::${terminalId}`;
      if (retiring.current.has(key)) continue;
      retiring.current.add(key);
      // Busy or unverifiable legacy sessions stay pending until the next mount.
      void disposeAndCloseTerminalSession({
        api,
        threadId,
        terminalId,
        deleteHistory: false,
        onlyIfIdle: true,
      })
        .then(() => {
          forgetRetiredTerminal(threadId, terminalId);
        })
        .catch((error: unknown) => {
          console.error("Failed to retire nested terminal", { threadId, terminalId, error });
        })
        .finally(() => retiring.current.delete(key));
    }
  }, [forgetRetiredTerminal, retiredTerminalIds, threadId]);

  return (
    <aside
      aria-label="Terminal"
      className="thread-terminal-drawer relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden app-content-surface"
    >
      <TerminalViewport
        key={activeTerminalId}
        threadId={threadId}
        terminalId={activeTerminalId}
        terminalLabel={
          props.terminalTitleOverridesById[activeTerminalId] ??
          props.terminalLabelsById[activeTerminalId] ??
          "Terminal"
        }
        terminalCliKind={props.terminalCliKindsById[activeTerminalId] ?? null}
        cwd={props.cwd}
        {...(props.runtimeEnv ? { runtimeEnv: props.runtimeEnv } : {})}
        onSessionExited={() => props.onTerminalSessionExited(activeTerminalId)}
        onTerminalMetadataChange={props.onTerminalMetadataChange}
        onTerminalActivityChange={props.onTerminalActivityChange}
        onAddTerminalContext={props.onAddTerminalContext}
        focusRequestId={props.focusRequestId}
        autoFocus
        isVisible={props.isVisible ?? true}
      />
    </aside>
  );
}
