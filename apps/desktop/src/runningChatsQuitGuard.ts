// FILE: runningChatsQuitGuard.ts
// Purpose: Coordinates the renderer Stay/Quit handshake before a user-initiated desktop quit.
// Layer: Desktop quit policy
// Depends on: Quit confirmation IPC payloads from the renderer.

import type {
  DesktopQuitConfirmationChat,
  DesktopQuitConfirmationPresentation,
  DesktopQuitConfirmationReference,
  DesktopQuitConfirmationRequest,
  DesktopQuitConfirmationResponse,
} from "@synara/contracts";

/** How long the app waits on the page before it stops asking and stays running. */
const DEFAULT_ANSWER_TIMEOUT_MS = 60_000;

export function shouldPromptForRunningChatsBeforeQuit(reason: string): boolean {
  return reason === "window-close" || reason === "before-quit";
}

export function quitConfirmationPresentationForPlatform(): DesktopQuitConfirmationPresentation {
  return "in-app";
}

export function parseQuitConfirmationRequest(
  payload: unknown,
): DesktopQuitConfirmationRequest | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const requestId = (payload as { readonly requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    return null;
  }
  const presentationRaw = (payload as { readonly presentation?: unknown }).presentation;
  return {
    requestId,
    presentation: presentationRaw === "native" ? "native" : "in-app",
  };
}

function parseQuitConfirmationChats(value: unknown): DesktopQuitConfirmationChat[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const chats: DesktopQuitConfirmationChat[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object") {
      continue;
    }
    const id = (item as { readonly id?: unknown }).id;
    const title = (item as { readonly title?: unknown }).title;
    if (typeof id !== "string" || id.trim().length === 0) {
      continue;
    }
    chats.push({
      id,
      title: typeof title === "string" ? title : "",
    });
  }
  return chats;
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
    readonly runningCount?: unknown;
    readonly chats?: unknown;
    readonly allow?: unknown;
  };
  if (typeof record.requestId !== "string" || record.requestId.trim().length === 0) {
    return null;
  }
  if (record.phase === "ready") {
    if (
      typeof record.runningCount !== "number" ||
      !Number.isSafeInteger(record.runningCount) ||
      record.runningCount < 0
    ) {
      return null;
    }
    return {
      requestId: record.requestId,
      phase: "ready",
      runningCount: record.runningCount,
      chats: parseQuitConfirmationChats(record.chats),
    };
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

/** A reference the page can match to the question it is showing. */
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

// The renderer bounds quit-resume preparation to 1.5 seconds.
const QUIT_PREPARATION_TIMEOUT_MS = 3_000;

export interface RunningChatsQuitGuard {
  readonly hasAllowedQuit: () => boolean;
  readonly hasPendingAsk: () => boolean;
  readonly isPendingRequest: (requestId: string) => boolean;
  readonly isPreparingQuit: () => boolean;
  readonly cancelPendingUnlessPreparing: () => void;
  /**
   * Resolve the pending ask as allowed WITHOUT latching `allowed` — a dead
   * renderer proved the ask can never be answered, not that the user said
   * yes, so a later quit must still get to ask. False when the question had
   * already expired or there was none.
   */
  readonly allowPending: () => boolean;
  /** A dead renderer: allow a live question, but let preparation finish. */
  readonly rendererGone: () => boolean;
  /** Main accepts the page's answer, pausing the silence deadline for preparation. */
  readonly beginPreparation: (requestId: string) => boolean;
  /** A repeated quit asks the page to answer its open question. */
  readonly repeatQuit: (notify: (requestId: string) => void) => boolean;
  readonly receiveResponse: (payload: unknown) => void;
  readonly askRenderer: (input: {
    readonly send: (request: DesktopQuitConfirmationRequest) => void;
    readonly isRendererAvailable: () => boolean;
    readonly answerTimeoutMs?: number;
    readonly preparationTimeoutMs?: number;
    readonly presentation?: DesktopQuitConfirmationPresentation;
    readonly withdraw?: (requestId: string) => void;
    readonly presentNativeConfirmation?: (
      chats: ReadonlyArray<DesktopQuitConfirmationChat>,
    ) => boolean | Promise<boolean>;
  }) => Promise<boolean>;
}

interface PendingQuitConfirmation {
  readonly requestId: string;
  readonly presentation: DesktopQuitConfirmationPresentation;
  readonly presentNativeConfirmation:
    | ((chats: ReadonlyArray<DesktopQuitConfirmationChat>) => boolean | Promise<boolean>)
    | undefined;
  readonly withdraw: ((requestId: string) => void) | undefined;
  readonly preparationTimeoutMs: number;
  phase: "requested" | "ready" | "preparing" | "repeating";
  /** Epoch ms when an unanswered question expires; null once preparation owns the wait. */
  deadlineAt: number | null;
  answerTimer: ReturnType<typeof setTimeout> | null;
  readonly resolve: (allow: boolean) => void;
}

export function makeRunningChatsQuitGuard(
  createRequestId: () => string = () => crypto.randomUUID(),
): RunningChatsQuitGuard {
  let allowed = false;
  let inFlight: Promise<boolean> | null = null;
  let pending: PendingQuitConfirmation | null = null;

  const clearAnswerTimer = (current: PendingQuitConfirmation | null): void => {
    if (!current?.answerTimer) return;
    clearTimeout(current.answerTimer);
    current.answerTimer = null;
  };

  const finish = (allow: boolean, options?: { readonly withdraw?: boolean }): void => {
    const current = pending;
    pending = null;
    clearAnswerTimer(current);
    if (allow) {
      allowed = true;
    }
    if (options?.withdraw && current) {
      current.withdraw?.(current.requestId);
    }
    current?.resolve(allow);
  };

  const presentNativeSheet = (
    current: PendingQuitConfirmation,
    chats: ReadonlyArray<DesktopQuitConfirmationChat>,
  ): void => {
    const presenter = current.presentNativeConfirmation;
    if (!presenter) {
      finish(true);
      return;
    }
    const requestId = current.requestId;
    void Promise.resolve()
      .then(() => presenter(chats))
      .then(
        (allow) => {
          if (pending?.requestId === requestId) {
            finish(allow);
          }
        },
        () => {
          if (pending?.requestId === requestId) {
            finish(true);
          }
        },
      );
  };

  const allowPending = (): boolean => {
    const current = pending;
    if (!current) return false;
    if (current.deadlineAt !== null && Date.now() >= current.deadlineAt) {
      finish(false, { withdraw: true });
      return false;
    }
    pending = null;
    clearAnswerTimer(current);
    current.withdraw?.(current.requestId);
    current.resolve(true);
    return true;
  };

  return {
    hasAllowedQuit: () => allowed,
    hasPendingAsk: () => pending !== null,
    isPendingRequest: (requestId) => {
      const current = pending;
      if (!current || current.requestId !== requestId) return false;
      if (current.phase === "preparing" || current.phase === "repeating") return false;
      if (current.deadlineAt !== null && Date.now() >= current.deadlineAt) return false;
      return true;
    },
    isPreparingQuit: () => pending?.phase === "preparing",
    cancelPendingUnlessPreparing(): void {
      if (pending?.phase === "preparing") return;
      finish(false, { withdraw: true });
    },
    allowPending,
    rendererGone: () => {
      if (pending?.phase === "preparing") return false;
      return allowPending();
    },
    beginPreparation(requestId): boolean {
      const current = pending;
      if (!current || current.requestId !== requestId) return false;
      if (current.phase !== "ready" && current.phase !== "repeating") return false;
      if (current.deadlineAt !== null && Date.now() >= current.deadlineAt) {
        finish(false, { withdraw: true });
        return false;
      }
      current.phase = "preparing";
      current.deadlineAt = null;
      clearAnswerTimer(current);
      current.answerTimer = setTimeout(() => {
        if (pending?.requestId === requestId) {
          finish(true);
        }
      }, current.preparationTimeoutMs);
      return true;
    },
    repeatQuit(notify): boolean {
      const current = pending;
      if (!current || current.phase !== "ready") return false;
      if (current.deadlineAt !== null && Date.now() >= current.deadlineAt) {
        finish(false, { withdraw: true });
        return false;
      }
      current.phase = "repeating";
      current.deadlineAt = null;
      clearAnswerTimer(current);
      current.answerTimer = setTimeout(() => {
        if (pending?.requestId === current.requestId) {
          // The page never answered the repeated quit. Cancel it instead of
          // quitting without the resume write; the next ⌘Q asks again.
          finish(false, { withdraw: true });
        }
      }, current.preparationTimeoutMs);
      try {
        notify(current.requestId);
      } catch {
        finish(false, { withdraw: true });
      }
      return true;
    },
    receiveResponse(payload: unknown): void {
      const response = parseQuitConfirmationResponse(payload);
      if (!response || pending == null || response.requestId !== pending.requestId) {
        return;
      }
      // A message can reach the main process just past the deadline but before
      // the timer callback runs. The deadline, not callback order, decides.
      if (pending.deadlineAt !== null && Date.now() >= pending.deadlineAt) {
        // Mirror the timer: a page that never acknowledged cannot show the
        // question and quits; a shown question just withdraws.
        finish(pending.phase === "requested");
        return;
      }
      if (response.phase === "decision") {
        finish(response.allow);
        return;
      }
      if (pending.phase !== "requested") return;
      pending.phase = "ready";
      if (pending.presentation === "native") {
        // The native sheet owns the answer; silence is not an open question.
        clearAnswerTimer(pending);
        if (response.runningCount <= 0) {
          finish(true);
          return;
        }
        presentNativeSheet(pending, response.chats);
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
        const presentation = input.presentation ?? "in-app";
        pending = {
          requestId,
          presentation,
          presentNativeConfirmation: input.presentNativeConfirmation,
          withdraw: input.withdraw,
          preparationTimeoutMs: input.preparationTimeoutMs ?? QUIT_PREPARATION_TIMEOUT_MS,
          phase: "requested",
          deadlineAt: Date.now() + (input.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS),
          answerTimer: setTimeout(() => {
            if (pending?.requestId !== requestId) return;
            // A page that never acknowledged the request cannot show it. Quit
            // rather than trapping the app for a minute with no question.
            if (pending.phase === "requested") {
              finish(true);
              return;
            }
            finish(false, { withdraw: true });
          }, input.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS),
          resolve: (allow) => {
            inFlight = null;
            resolve(allow);
          },
        };
        try {
          input.send({ requestId, presentation });
        } catch {
          finish(true);
        }
      });
      return inFlight;
    },
  };
}
