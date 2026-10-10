// Presentation-only ticking: do not use this for provider work or transport liveness.
// Re-read wall time on resume rather than replaying ticks missed while hidden.
export function startVisibleInterval(onTick: () => void, intervalMs: number): () => void {
  let intervalId: number | null = null;
  let refreshId: number | null = null;

  const stop = () => {
    if (refreshId !== null) {
      window.clearTimeout(refreshId);
      refreshId = null;
    }
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };

  const syncVisibility = () => {
    if (document.visibilityState !== "visible") {
      stop();
      return;
    }
    if (intervalId !== null) {
      return;
    }
    // Keep the initial refresh asynchronous for React Compiler, as useNowMs did. The same refresh makes elapsed labels current immediately after resuming.
    refreshId = window.setTimeout(() => {
      refreshId = null;
      onTick();
    }, 0);
    intervalId = window.setInterval(onTick, intervalMs);
  };

  document.addEventListener("visibilitychange", syncVisibility);
  syncVisibility();
  return () => {
    document.removeEventListener("visibilitychange", syncVisibility);
    stop();
  };
}
