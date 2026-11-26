// FILE: runningChatsQuitGuard.ts
// Purpose: Coordinates the renderer Stay/Quit handshake before a user-initiated desktop quit.
// Layer: Desktop quit policy
// Depends on: Quit confirmation IPC payloads from the renderer.

import type {
  DesktopQuitConfirmationReference,
  DesktopQuitConfirmationResponse,
} from "@synara/contracts";

/** How long the page gets to answer at whichever phase it is in. */
const DEFAULT_TIMEOUT_MS = 3000;

export function shouldPromptForRunningChatsBeforeQuit(reason: string): boolean {
  return reason === "window-close" || reason === "before-quit";
}

export function parseQuitConfirmationReference(
  payload: unknown,
): DesktopQuitConfirmationReference | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const requestId = (payload as { readonly requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    return null;
  }
  return { requestId };
}

export function parseQuitConfirmationResponse(
  payload: unknown,
): DesktopQuitConfirmationResponse | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    readonly requestId?: unknown;
    readonly phase?: unknown;
    readonly allow?: unknown;
  };
  if (typeof record.requestId !== "string" || record.requestId.trim().length === 0) {
    return null;
  }
  if (record.phase === "ready") {
    return { requestId: record.requestId, phase: "ready" };
  }
  if (record.phase === "decision" && typeof record.allow === "boolean") {
    return {
      requestId: record.requestId,
      phase: "decision",
      allow: record.allow,
    };
  }
  return null;
}

export interface RunningChatsQuitGuard {
  readonly hasAllowedQuit: () => boolean;
  readonly hasPendingAsk: () => boolean;
  readonly cancelPending: () => void;
  /**
   * Resolve the pending ask as allowed WITHOUT latching `allowed` — a dead
   * renderer proved the ask can never be answered, not that the user said
   * yes, so a later quit must still get to ask.
   */
  readonly allowPending: () => void;
  /**
   * A repeated quit confirms the question the page is showing, so the same
   * interrupt and resume path runs as when the user presses Quit. A repeat that
   * arrives before the page has acknowledged is armed too: the page still gets
   * to answer, and the repeat quits anyway if it never does.
   */
  readonly repeatQuit: (notify: (requestId: string) => void) => void;
  readonly receiveResponse: (payload: unknown) => void;
  /**
   * The page commits to the quit before it stops any chat. False when the
   * question already expired or was withdrawn, so the page must not stop
   * anything. A committed question can no longer be cancelled.
   */
  readonly beginCommit: (requestId: string) => boolean;
  readonly askRenderer: (input: {
    readonly send: (request: DesktopQuitConfirmationReference) => void;
    readonly isRendererAvailable: () => boolean;
    /** Called once the page acknowledges that it will show the question. */
    readonly onReady?: () => void;
    /** How long the page gets to answer at whichever phase it is in. */
    readonly timeoutMs?: number;
    /** Tells the page that a question it may still be showing is no longer open. */
    readonly withdraw?: (requestId: string) => void;
  }) => Promise<boolean>;
}

interface PendingQuitConfirmation {
  readonly requestId: string;
  readonly withdraw: ((requestId: string) => void) | undefined;
  readonly onReady: (() => void) | undefined;
  readonly timeoutMs: number;
  waitingForDecision: boolean;
  /** How to ask the page to answer a repeat that arrived before it acked, once it does. */
  notifyRepeat: ((requestId: string) => void) | null;
  /** Force-quits when the page does not answer the phase it is in. */
  deadline: ReturnType<typeof setTimeout> | null;
  /** The page proved it is stopping chats, so the quit can no longer be withdrawn. */
  committed: boolean;
  readonly resolve: (allow: boolean) => void;
}

export function makeRunningChatsQuitGuard(
  createRequestId: () => string = () => crypto.randomUUID(),
): RunningChatsQuitGuard {
  let allowed = false;
  let inFlight: Promise<boolean> | null = null;
  let pending: PendingQuitConfirmation | null = null;

  const clearDeadline = (current: PendingQuitConfirmation | null): void => {
    if (current?.deadline) {
      clearTimeout(current.deadline);
      current.deadline = null;
    }
  };

  const notifyOrQuit = (
    current: PendingQuitConfirmation,
    notify: (requestId: string) => void,
  ): void => {
    try {
      notify(current.requestId);
    } catch {
      finish(true);
    }
  };

  const finish = (allow: boolean, options?: { readonly withdraw?: boolean }): void => {
    const current = pending;
    pending = null;
    clearDeadline(current);
    if (allow) {
      allowed = true;
    }
    if (options?.withdraw && current) {
      try {
        current.withdraw?.(current.requestId);
      } catch {
        // A page that cannot hear the withdrawal just keeps a stale dialog.
      }
    }
    current?.resolve(allow);
  };

  // A page that cannot answer must not keep the app alive: the user asked
  // twice, the page already committed and can no longer report back, or it
  // never acknowledged at all.
  const armDeadline = (current: PendingQuitConfirmation): void => {
    clearDeadline(current);
    current.deadline = setTimeout(() => {
      if (pending?.requestId === current.requestId) {
        finish(true);
      }
    }, current.timeoutMs);
  };

  return {
    hasAllowedQuit: () => allowed,
    hasPendingAsk: () => pending !== null,
    cancelPending(): void {
      // A committed question is already being honoured: the chats are stopping
      // and the record is written, so the later decision quits the app.
      if (pending?.committed) {
        return;
      }
      finish(false, { withdraw: true });
    },
    allowPending(): void {
      const current = pending;
      pending = null;
      clearDeadline(current);
      current?.resolve(true);
    },
    repeatQuit(notify): void {
      const current = pending;
      if (!current) {
        return;
      }
      if (!current.waitingForDecision) {
        // The page has not acked yet. Ask it as soon as it does, and let the
        // deadline decide if it never does.
        current.notifyRepeat = notify;
        return;
      }
      armDeadline(current);
      notifyOrQuit(current, notify);
    },
    beginCommit(requestId: string): boolean {
      if (pending?.requestId !== requestId) {
        return false;
      }
      // The page acked and is about to stop chats, so an ack deadline that has
      // not fired yet must not quit out from under it.
      pending.committed = true;
      // Nothing else can end a committed ask if its decision is lost — a reload
      // during the page's bounded resume write leaves no question on screen —
      // so the deadline moves to the phase it is in now.
      armDeadline(pending);
      return true;
    },
    receiveResponse(payload: unknown): void {
      const response = parseQuitConfirmationResponse(payload);
      if (!response || pending == null || response.requestId !== pending.requestId) {
        return;
      }
      if (response.phase === "decision") {
        // A committed ask already stopped chats and wrote the resume record, so
        // the app can no longer stay: ignore a denial and let the deadline quit.
        if (pending.committed && !response.allow) {
          return;
        }
        finish(response.allow);
        return;
      }
      clearDeadline(pending);
      pending.waitingForDecision = true;
      pending.onReady?.();
      const notifyRepeat = pending.notifyRepeat;
      if (notifyRepeat) {
        // The page shows the question now: give it the repeat and the deadline
        // that force-quits if it cannot answer.
        pending.notifyRepeat = null;
        armDeadline(pending);
        notifyOrQuit(pending, notifyRepeat);
      }
    },
    askRenderer(input): Promise<boolean> {
      if (allowed) {
        return Promise.resolve(true);
      }
      if (inFlight) {
        return inFlight;
      }
      if (!input.isRendererAvailable()) {
        return Promise.resolve(true);
      }

      inFlight = new Promise<boolean>((resolve) => {
        const requestId = createRequestId();
        pending = {
          requestId,
          withdraw: input.withdraw,
          onReady: input.onReady,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          waitingForDecision: false,
          notifyRepeat: null,
          deadline: null,
          committed: false,
          resolve: (allow) => {
            inFlight = null;
            resolve(allow);
          },
        };
        armDeadline(pending);
        try {
          input.send({ requestId });
        } catch {
          finish(true);
        }
      });
      return inFlight;
    },
  };
}
