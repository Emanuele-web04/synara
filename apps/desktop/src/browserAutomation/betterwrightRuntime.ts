import { BetterWright, NetworkPolicy, type CredentialVault } from "betterwright";
import { BrowserAutomationErrorMessages } from "@synara/contracts";
import type { WebContents } from "electron";
import { synaraHostTarget } from "./betterwrightHostTarget";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BrowserAutomationHostError } from "./hostErrors";

const UNAVAILABLE_SCRIPT_API_ERRORS = new Set([
  ...[
    "getByRole",
    "getByLabel",
    "getByText",
    "getByPlaceholder",
    "getByTestId",
    "locator",
    "document",
    "window",
    "location",
    "waitForTimeout",
  ].map((name) => `${name} is not defined`),
  "page.snapshot is not a function",
]);

export interface BetterwrightRunOptions {
  readonly home: string;
  readonly contents: WebContents;
  readonly code: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly vault?: CredentialVault;
  readonly uploadFiles?: readonly string[];
  readonly expectAgentInput?: BrowserAutomationVisibleRuntime["expectAgentInput"];
  readonly retainFocusAfterInput?: BrowserAutomationVisibleRuntime["retainFocusAfterInput"];
}

/** The caller must hold Synara's tab, human-control and download-denial leases. */
export async function runBetterwright<T>(options: BetterwrightRunOptions): Promise<T> {
  options.signal.throwIfAborted();
  const throttled = options.contents.getBackgroundThrottling();
  // Locator stability checks require animation frames even when the agent's
  // native view is parked behind the composer. Restore the idle policy after
  // the worker and its CDP connection have both drained.
  if (throttled) options.contents.setBackgroundThrottling(false);
  try {
    return await runConnectedBetterwright<T>(options);
  } finally {
    if (throttled && !options.contents.isDestroyed()) {
      options.contents.setBackgroundThrottling(true);
    }
  }
}

async function runConnectedBetterwright<T>(options: BetterwrightRunOptions): Promise<T> {
  const hostTarget = synaraHostTarget(options.contents, {
    uploadFiles: options.uploadFiles,
    expectAgentInput: options.expectAgentInput,
    retainFocusAfterInput: options.retainFocusAfterInput,
    signal: options.signal,
  });
  let onAbortRace: (() => void) | undefined;
  const aborting = new Promise<never>((_, reject) => {
    onAbortRace = () => reject(options.signal.reason ?? new Error("Browser run cancelled."));
    options.signal.addEventListener("abort", onAbortRace, { once: true });
  });
  let browser: BetterWright | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (cancel: boolean): Promise<void> => {
    // Revoke synchronously before requesting worker shutdown. Neither completion
    // nor cancellation releases the host's tab lock until both have drained.
    stopping ??= Promise.allSettled([hostTarget.revokeAll(cancel), browser?.close()]).then(
      (results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      },
    );
    return stopping;
  };
  const onAbort = () => {
    void stop(true).catch(() => {});
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  let succeeded = false;
  try {
    options.signal.throwIfAborted();
    browser = new BetterWright({
      home: options.home,
      hostTarget,
      ...(options.uploadFiles ? { hostUploadFiles: options.uploadFiles } : {}),
      downloadPolicy: "deny",
      vault: options.vault ?? false,
      credentialCapture: false,
      headless: false,
      adBlock: false,
      parkBackgroundPages: false,
      policy: new NetworkPolicy({ allowLoopback: true }),
    });
    const result = await Promise.race([
      browser.run<T>(options.code, {
        timeout: options.timeoutMs / 1000,
        signal: options.signal,
        // Shared tabs never consume the automatic UI catalog; opting out keeps
        // worker traffic to the evaluated script.
        automaticUI: false,
      }),
      aborting,
    ]);
    options.signal.throwIfAborted();
    if (!result.ok) {
      // Only fixed host-owned guidance crosses the boundary, never worker error text.
      const credentialTarget =
        typeof result.error === "string" &&
        /^credential form (?:not-found:|ambiguous:|detection found no password field\.|submit detection failed:)/u.test(
          result.error,
        );
      throw new BrowserAutomationHostError({
        code:
          result.error === BrowserAutomationErrorMessages.BrowserCredentialUseUnavailable
            ? "BrowserCredentialUseUnavailable"
            : typeof result.error === "string" && UNAVAILABLE_SCRIPT_API_ERRORS.has(result.error)
              ? "BrowserScriptApiUnavailable"
              : credentialTarget
                ? "BrowserCredentialTargetRequired"
                : "BrowserEvaluationFailed",
        retryable: false,
        phase: "evaluate",
        effectMayHaveCommitted: true,
      });
    }
    succeeded = true;
    return result.result as T;
  } finally {
    if (onAbortRace) options.signal.removeEventListener("abort", onAbortRace);
    options.signal.removeEventListener("abort", onAbort);
    await stop(!succeeded);
  }
}
