import { setTimeout as delay } from "node:timers/promises";
import type { ComputerLaunchAppResult, ComputerWindow } from "@synara/contracts";
import { withDesktopOperationSignal } from "./DesktopOperationQueue.ts";

const unavailable = (windowReason: NonNullable<ComputerLaunchAppResult["windowReason"]>) => ({
  window: null,
  windowStatus: "no_usable_window" as const,
  windowReason,
});

/** Match an app name/path conservatively; ambiguity never picks a window. */
export async function waitForWindow(
  read: () => Promise<readonly ComputerWindow[]>,
  app: string,
  timeoutMs: number,
  signal?: AbortSignal,
  target?: {
    readonly pid?: number;
    readonly checkInputReady?: (windowId: string) => Promise<void>;
  },
): Promise<Pick<ComputerLaunchAppResult, "window" | "windowStatus" | "windowReason">> {
  // A hung list/AX probe must not defeat the readiness polling budget. Abort
  // only this read-only phase; the launch has already been sent and is never
  // replayed or described as not dispatched.
  const controller = new AbortController();
  const probeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        controller.abort(new Error("Launch window readiness timed out."));
        reject(controller.signal.reason);
      },
      Math.min(2_000, Math.max(1, timeoutMs || 2_000)),
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([
      withDesktopOperationSignal(probeSignal, () =>
        probeWindow(read, app, timeoutMs, probeSignal, target),
      ),
      timeout,
    ]);
  } catch {
    signal?.throwIfAborted();
    return unavailable("input_unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

async function probeWindow(
  read: () => Promise<readonly ComputerWindow[]>,
  app: string,
  timeoutMs: number,
  signal: AbortSignal,
  target:
    | { readonly pid?: number; readonly checkInputReady?: (windowId: string) => Promise<void> }
    | undefined,
): Promise<Pick<ComputerLaunchAppResult, "window" | "windowStatus" | "windowReason">> {
  const name = app
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.app$/i, "")
    .toLocaleLowerCase();
  const deadline = performance.now() + Math.min(2_000, Math.max(0, timeoutMs));
  while (true) {
    signal?.throwIfAborted();
    const matches = (await read()).filter((window) =>
      target?.pid !== undefined
        ? window.pid === target.pid
        : window.appName?.toLocaleLowerCase() === name,
    );
    signal?.throwIfAborted();
    // Do not select a sibling just because it happens to be visible: only a
    // unique titled, usable primary window with sufficient bounds disambiguates.
    const primaryCandidates = matches.filter(
      (window) =>
        window.visible &&
        !window.minimized &&
        window.onCurrentSpace !== false &&
        window.title.trim().length > 0 &&
        window.bounds !== undefined &&
        window.bounds.width >= 120 &&
        window.bounds.height >= 80,
    );
    if (matches.length > 1 && primaryCandidates.length !== 1) return unavailable("ambiguous");
    const candidate = matches.length > 1 ? primaryCandidates[0] : matches[0];
    const reason = !candidate
      ? "no_window"
      : candidate.onCurrentSpace === false
        ? "off_space"
        : !candidate.visible || candidate.minimized
          ? "hidden"
          : undefined;
    if (candidate && reason === undefined) {
      try {
        await target?.checkInputReady?.(candidate.id);
      } catch {
        signal?.throwIfAborted();
        return unavailable("input_unavailable");
      }
      signal?.throwIfAborted();
      return { window: candidate, windowStatus: "ready" };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return unavailable(reason ?? "input_unavailable");
    await delay(Math.min(150, remaining), undefined, { signal });
  }
}
