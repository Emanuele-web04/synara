import { ThreadId } from "@synara/contracts";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";

const SETUP_SCRIPT_TERMINAL_ACTIVITY_START_TIMEOUT_MS = 1_000;
const SETUP_SCRIPT_TERMINAL_MAX_RUNTIME_MS = 10 * 60 * 1000;

function terminalHasRunningSubprocess(threadId: ThreadId, terminalId: string): boolean {
  const terminalState = selectThreadTerminalState(
    useTerminalStateStore.getState().terminalStateByThreadId,
    threadId,
  );
  return terminalState.runningTerminalIds.includes(terminalId);
}

export function waitForSetupScriptTerminalActivity(input: {
  threadId: ThreadId;
  terminalId: string;
  observeStartTimeoutMs?: number;
  maxRuntimeMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  const observeStartTimeoutMs =
    input.observeStartTimeoutMs ?? SETUP_SCRIPT_TERMINAL_ACTIVITY_START_TIMEOUT_MS;
  const maxRuntimeMs = input.maxRuntimeMs ?? SETUP_SCRIPT_TERMINAL_MAX_RUNTIME_MS;

  return new Promise((resolve) => {
    let resolved = false;
    let observedRunning = terminalHasRunningSubprocess(input.threadId, input.terminalId);
    let observeStartTimer: number | null = null;
    let maxRuntimeTimer: number | null = null;

    const unsubscribe = useTerminalStateStore.subscribe(() => {
      checkRunningState();
    });

    const clearTimers = () => {
      if (observeStartTimer !== null) {
        window.clearTimeout(observeStartTimer);
        observeStartTimer = null;
      }
      if (maxRuntimeTimer !== null) {
        window.clearTimeout(maxRuntimeTimer);
        maxRuntimeTimer = null;
      }
    };

    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      unsubscribe();
      input.signal?.removeEventListener("abort", finish);
      resolve();
    };

    const ensureMaxRuntimeTimer = () => {
      if (maxRuntimeTimer !== null) return;
      maxRuntimeTimer = window.setTimeout(finish, maxRuntimeMs);
    };

    function checkRunningState() {
      const running = terminalHasRunningSubprocess(input.threadId, input.terminalId);
      if (running) {
        observedRunning = true;
        if (observeStartTimer !== null) {
          window.clearTimeout(observeStartTimer);
          observeStartTimer = null;
        }
        ensureMaxRuntimeTimer();
        return;
      }
      if (observedRunning) {
        finish();
      }
    }

    if (input.signal?.aborted) {
      finish();
      return;
    }
    input.signal?.addEventListener("abort", finish, { once: true });
    checkRunningState();
    if (!observedRunning) {
      observeStartTimer = window.setTimeout(finish, observeStartTimeoutMs);
    }
  });
}
