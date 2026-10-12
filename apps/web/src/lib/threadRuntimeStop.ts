import type { ContextMenuItem, NativeApi, ThreadId, TurnId } from "@synara/contracts";

interface StopAgentProcessThreadView {
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null;
  readonly session?: {
    readonly status: string;
    readonly activeTurnId?: TurnId | null | undefined;
  } | null;
}

/** Projected state is only a menu hint; the server admits idle cleanup. */
export function getStopAgentProcessMenuItem(
  thread: StopAgentProcessThreadView,
): ContextMenuItem<"stop-agent-process"> | null {
  if (
    thread.parentThreadId ||
    !thread.session ||
    !["ready", "running", "connecting"].includes(thread.session.status)
  ) {
    return null;
  }
  return {
    id: "stop-agent-process",
    icon: "stop",
    label:
      thread.session.activeTurnId != null
        ? "Stop agent process (turn in progress)"
        : "Stop agent process",
    separatorBefore: true,
  };
}

/** Use the current thread snapshot after the context menu resolves. */
export async function stopIdleRuntimeSessionFromClient(
  api: Pick<NativeApi["provider"], "stopIdleRuntimeSession">,
  thread: StopAgentProcessThreadView,
): Promise<void> {
  if (thread.parentThreadId) {
    throw new Error("Subagents share their parent thread's agent process.");
  }
  if (thread.session?.activeTurnId != null) {
    throw new Error("Interrupt the current turn before stopping the agent process.");
  }
  await api.stopIdleRuntimeSession({ threadId: thread.id });
}
