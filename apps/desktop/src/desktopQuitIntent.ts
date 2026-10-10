export interface DeferredDesktopQuitIntent {
  readonly reason: string;
}

export type DeferredDesktopQuitSettlement =
  | { readonly type: "replay-quit"; readonly intent: DeferredDesktopQuitIntent }
  | { readonly type: "resume-app" }
  | { readonly type: "already-replaying" };

export interface DeferredDesktopQuitIntentCoordinator {
  readonly defer: (reason: string) => boolean;
  readonly observeUpdaterQuitAttempt: () => boolean;
  readonly settleAfterUpdaterFailure: () => DeferredDesktopQuitSettlement;
}

export type DeferredDesktopQuitFailureOutcome =
  | "replayed-quit"
  | "resumed-app"
  | "already-replaying";

// keeps the first quit request while the updater owns shutdown — consuming before replay makes repeated failure signals idempotent and prevents multiple app.quit() chains
export function makeDeferredDesktopQuitIntentCoordinator(): DeferredDesktopQuitIntentCoordinator {
  let pending: DeferredDesktopQuitIntent | null = null;
  let replayStarted = false;

  return {
    defer(reason: string): boolean {
      if (pending !== null || replayStarted) {
        return false;
      }
      pending = { reason };
      return true;
    },
    observeUpdaterQuitAttempt(): boolean {
      return pending !== null;
    },
    settleAfterUpdaterFailure(): DeferredDesktopQuitSettlement {
      if (replayStarted) {
        return { type: "already-replaying" };
      }
      if (pending === null) {
        return { type: "resume-app" };
      }
      const intent = pending;
      pending = null;
      replayStarted = true;
      return { type: "replay-quit", intent };
    },
  };
}

export function settleDeferredDesktopQuitAfterUpdaterFailure(
  coordinator: DeferredDesktopQuitIntentCoordinator,
  actions: {
    readonly replayQuit: (intent: DeferredDesktopQuitIntent) => void;
    readonly resumeApp: () => void;
  },
): DeferredDesktopQuitFailureOutcome {
  const settlement = coordinator.settleAfterUpdaterFailure();
  switch (settlement.type) {
    case "replay-quit":
      actions.replayQuit(settlement.intent);
      return "replayed-quit";
    case "resume-app":
      actions.resumeApp();
      return "resumed-app";
    case "already-replaying":
      return "already-replaying";
  }
}
