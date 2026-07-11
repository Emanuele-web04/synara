import { isBackendReadinessAborted } from "./backendReadiness";

export interface WaitForBackendStartupReadyOptions {
  readonly listeningPromise?: Promise<void> | null;
  readonly waitForHttpReady: () => Promise<void>;
  readonly cancelHttpWait: () => void;
}

export interface MonitorBackendStartupHealthOptions {
  readonly waitUntilReady: (signal: AbortSignal) => Promise<void>;
  readonly isCurrent: () => boolean;
  readonly onReady: () => void;
  readonly retryDelayMs?: number;
}

const DEFAULT_STARTUP_HEALTH_RETRY_DELAY_MS = 1_000;

function waitForStartupHealthRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function isBackendStartupReadyResponse(response: Response): Promise<boolean> {
  if (!response.ok) {
    return false;
  }
  try {
    const payload = (await response.json()) as {
      startupReady?: unknown;
    };
    return payload.startupReady === true;
  } catch {
    return false;
  }
}

export function monitorBackendStartupHealth(
  options: MonitorBackendStartupHealthOptions,
): AbortController {
  const controller = new AbortController();
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_STARTUP_HEALTH_RETRY_DELAY_MS;

  void (async () => {
    while (!controller.signal.aborted && options.isCurrent()) {
      try {
        await options.waitUntilReady(controller.signal);
      } catch {
        if (controller.signal.aborted || !options.isCurrent()) {
          return;
        }
        await waitForStartupHealthRetry(controller.signal, retryDelayMs);
        continue;
      }

      if (!controller.signal.aborted && options.isCurrent()) {
        options.onReady();
      }
      return;
    }
  })();

  return controller;
}

export async function waitForBackendStartupReady(
  options: WaitForBackendStartupReadyOptions,
): Promise<"listening" | "http"> {
  const httpReadyPromise = options.waitForHttpReady();
  const listeningPromise = options.listeningPromise;

  if (!listeningPromise) {
    await httpReadyPromise;
    return "http";
  }

  return await new Promise<"listening" | "http">((resolve, reject) => {
    let settled = false;

    const settleResolve = (source: "listening" | "http") => {
      if (settled) {
        return;
      }
      settled = true;
      if (source === "listening") {
        options.cancelHttpWait();
      }
      resolve(source);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    listeningPromise.then(
      () => settleResolve("listening"),
      (error) => settleReject(error),
    );
    httpReadyPromise.then(
      () => settleResolve("http"),
      (error) => {
        if (settled && isBackendReadinessAborted(error)) {
          return;
        }
        settleReject(error);
      },
    );
  });
}
