import * as Http from "node:http";
import type { ChildProcess } from "node:child_process";

export const DESKTOP_BACKEND_SHUTDOWN_PATH = "/api/desktop/shutdown";

export type BackendShutdownProcess = Pick<
  ChildProcess,
  "exitCode" | "signalCode" | "once" | "off" | "kill"
>;

export type DesktopBackendShutdownRequestOutcome =
  | { readonly type: "response"; readonly statusCode: number }
  | { readonly type: "error" }
  | { readonly type: "cancelled" };

export interface PendingDesktopBackendShutdownRequest {
  readonly outcome: Promise<DesktopBackendShutdownRequestOutcome>;
  readonly cancel: () => void;
}

export type StartDesktopBackendShutdownRequest = (input: {
  readonly backendHttpUrl: string;
  readonly shutdownToken: string;
}) => PendingDesktopBackendShutdownRequest;

export type WindowsBackendShutdownResult =
  | { readonly type: "already-exited"; readonly forced: false }
  | { readonly type: "exited"; readonly forced: boolean }
  | { readonly type: "timed-out"; readonly forced: boolean };

export class WindowsBackendShutdownTimeoutError extends Error {
  readonly forced: boolean;

  constructor(result: Extract<WindowsBackendShutdownResult, { readonly type: "timed-out" }>) {
    super("Timed out waiting for the Windows desktop backend to exit.");
    this.name = "WindowsBackendShutdownTimeoutError";
    this.forced = result.forced;
  }
}

export function requireWindowsBackendExit(result: WindowsBackendShutdownResult): void {
  if (result.type === "timed-out") {
    throw new WindowsBackendShutdownTimeoutError(result);
  }
}

export async function runAfterDesktopShutdown(
  shutdown: Promise<void>,
  afterShutdown: () => void | Promise<void>,
): Promise<void> {
  await shutdown;
  await afterShutdown();
}

export function shouldDeferDesktopWindowClose(input: {
  readonly platform: NodeJS.Platform;
  readonly shutdownComplete: boolean;
  readonly updaterHandoffActive: boolean;
}): boolean {
  return input.platform === "win32" && !input.shutdownComplete && !input.updaterHandoffActive;
}

const shutdownsByProcess = new WeakMap<object, Promise<WindowsBackendShutdownResult>>();

function isLoopbackShutdownUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    !url.username &&
    !url.password &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1")
  );
}

function resolveDesktopBackendShutdownUrl(backendHttpUrl: string): URL {
  const url = new URL(backendHttpUrl);
  if (!isLoopbackShutdownUrl(url)) {
    throw new Error("Desktop backend shutdown requires an HTTP loopback endpoint.");
  }
  url.pathname = DESKTOP_BACKEND_SHUTDOWN_PATH;
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * Begins the desktop-only shutdown POST without placing its credential in a URL.
 * The caller owns the request lifetime and must cancel it when the child exits or
 * the overall shutdown deadline is reached.
 */
export function startDesktopBackendShutdownRequest(input: {
  readonly backendHttpUrl: string;
  readonly shutdownToken: string;
}): PendingDesktopBackendShutdownRequest {
  if (!input.shutdownToken) {
    throw new Error("Desktop backend shutdown token is required.");
  }

  const url = resolveDesktopBackendShutdownUrl(input.backendHttpUrl);
  let request: Http.ClientRequest | null = null;
  let response: Http.IncomingMessage | null = null;
  let cancelled = false;
  let completed = false;
  let completeOutcome: ((outcome: DesktopBackendShutdownRequestOutcome) => void) | null = null;
  const outcome = new Promise<DesktopBackendShutdownRequestOutcome>((resolve) => {
    completeOutcome = resolve;
  });

  const complete = (result: DesktopBackendShutdownRequestOutcome): void => {
    if (completed) return;
    completed = true;
    completeOutcome?.(result);
  };

  request = Http.request(
    url,
    {
      method: "POST",
      agent: false,
      headers: {
        Authorization: `Bearer ${input.shutdownToken}`,
        "Content-Length": "0",
      },
    },
    (incoming) => {
      response = incoming;
      incoming.resume();
      complete({ type: "response", statusCode: incoming.statusCode ?? 0 });
      if (cancelled) {
        incoming.destroy();
      }
    },
  );
  request.once("error", () => {
    complete(cancelled ? { type: "cancelled" } : { type: "error" });
  });
  request.end();

  return {
    outcome,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      complete({ type: "cancelled" });
      response?.destroy();
      request?.destroy();
    },
  };
}

function hasExited(child: BackendShutdownProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function runWindowsBackendShutdown(input: {
  readonly child: BackendShutdownProcess;
  readonly backendHttpUrl: string;
  readonly shutdownToken: string;
  readonly forceKillDelayMs: number;
  readonly timeoutMs: number;
  readonly startRequest: StartDesktopBackendShutdownRequest;
  readonly forceTerminate: (child: BackendShutdownProcess) => void;
}): Promise<WindowsBackendShutdownResult> {
  if (hasExited(input.child)) {
    return Promise.resolve({ type: "already-exited", forced: false });
  }

  return new Promise<WindowsBackendShutdownResult>((resolve) => {
    let settled = false;
    let forced = false;
    let pendingRequest: PendingDesktopBackendShutdownRequest | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: WindowsBackendShutdownResult): void => {
      if (settled) return;
      settled = true;
      input.child.off("exit", onExit);
      if (forceTimer) clearTimeout(forceTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      try {
        pendingRequest?.cancel();
      } catch {
        // Request cleanup must not delay or invalidate process-exit proof.
      }
      resolve(result);
    };

    const onExit = (): void => {
      settle({ type: "exited", forced });
    };

    input.child.once("exit", onExit);

    // The listener is installed first so an exit racing request construction
    // cannot be missed. Synchronous transport failures still use the same timers.
    try {
      pendingRequest = input.startRequest({
        backendHttpUrl: input.backendHttpUrl,
        shutdownToken: input.shutdownToken,
      });
      if (settled) {
        pendingRequest.cancel();
        return;
      }
      void pendingRequest.outcome.catch(() => {
        // A custom request implementation cannot shorten or reset the deadline.
      });
    } catch {
      pendingRequest = null;
    }

    if (hasExited(input.child)) {
      onExit();
      return;
    }

    const forceIfRunning = (): void => {
      if (settled || hasExited(input.child)) {
        if (hasExited(input.child)) onExit();
        return;
      }
      forced = true;
      try {
        input.forceTerminate(input.child);
      } catch {
        // The absolute deadline still bounds shutdown if force termination fails.
      }
      if (hasExited(input.child)) {
        onExit();
      }
    };

    if (input.forceKillDelayMs === 0) {
      // Node normalizes sub-1 ms timers to the same effective delay. Run the
      // zero-delay fallback now so it is provably before the overall timer.
      forceIfRunning();
    } else {
      forceTimer = setTimeout(forceIfRunning, input.forceKillDelayMs);
      unrefTimer(forceTimer);
    }

    if (settled) return;

    deadlineTimer = setTimeout(() => {
      // Process state wins at the boundary even if an exit event is queued for
      // the same turn; an HTTP response alone is never treated as success.
      if (hasExited(input.child)) {
        onExit();
        return;
      }
      settle({ type: "timed-out", forced });
    }, input.timeoutMs);
    unrefTimer(deadlineTimer);
  });
}

/**
 * Requests graceful Windows backend shutdown, waits for actual child exit, and
 * performs at most one forceful fallback at the original absolute threshold.
 * Repeated calls for the same live process share one operation.
 */
export function stopWindowsBackendAndWait(input: {
  readonly child: BackendShutdownProcess;
  readonly backendHttpUrl: string;
  readonly shutdownToken: string;
  readonly forceKillDelayMs: number;
  readonly timeoutMs: number;
  readonly startRequest?: StartDesktopBackendShutdownRequest;
  readonly forceTerminate?: (child: BackendShutdownProcess) => void;
}): Promise<WindowsBackendShutdownResult> {
  const existing = shutdownsByProcess.get(input.child);
  if (existing) return existing;

  if (
    !Number.isFinite(input.forceKillDelayMs) ||
    !Number.isFinite(input.timeoutMs) ||
    input.forceKillDelayMs < 0 ||
    input.timeoutMs <= 0 ||
    input.forceKillDelayMs >= input.timeoutMs
  ) {
    throw new RangeError("Backend force-kill delay must be non-negative and precede timeout.");
  }

  const operation = runWindowsBackendShutdown({
    ...input,
    startRequest: input.startRequest ?? startDesktopBackendShutdownRequest,
    forceTerminate: input.forceTerminate ?? ((child) => void child.kill("SIGTERM")),
  });
  shutdownsByProcess.set(input.child, operation);
  void operation.then((result) => {
    if (result.type === "timed-out" && shutdownsByProcess.get(input.child) === operation) {
      shutdownsByProcess.delete(input.child);
    }
  });
  return operation;
}
