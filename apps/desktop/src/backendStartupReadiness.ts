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

  void options.waitUntilReady(controller.signal).then(
    () => {
      if (!controller.signal.aborted && options.isCurrent()) {
        options.onReady();
      }
    },
    () => undefined,
  );

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
      (error) => {
        if (settled) {
          return;
        }
        options.cancelHttpWait();
        settleReject(error);
      },
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
