import { setTimeout as delay } from "node:timers/promises";
import type { ComputerLaunchAppResult, ComputerWindow } from "@synara/contracts";
import { withDesktopOperationSignal } from "./DesktopOperationQueue.ts";

const unavailable = (windowReason: NonNullable<ComputerLaunchAppResult["windowReason"]>) => ({
  window: null,
  windowStatus: "no_usable_window" as const,
  windowReason,
});

/**
 * What the launch itself established about the process it started.
 *
 * `pid` alone is the historical rule and stays exact: a window of that
 * process, and no other. `appId` is a backend's statement that the pid may be
 * a launcher's — flatpak, `gio launch` and single-instance apps hand the
 * window to a different process — so a window of that app identity counts
 * too, as does the launch name, whenever no window carries the pid.
 */
export interface LaunchedWindowTarget {
  readonly pid?: number;
  readonly appId?: string;
  readonly checkInputReady?: (windowId: string) => Promise<void>;
}

/** Match an app name/path conservatively; ambiguity never picks a window. */
export async function waitForWindow(
  read: () => Promise<readonly ComputerWindow[]>,
  app: string,
  timeoutMs: number,
  signal?: AbortSignal,
  target?: LaunchedWindowTarget,
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
  target: LaunchedWindowTarget | undefined,
): Promise<Pick<ComputerLaunchAppResult, "window" | "windowStatus" | "windowReason">> {
  const name = launchName(app);
  const deadline = performance.now() + Math.min(2_000, Math.max(0, timeoutMs));
  while (true) {
    signal?.throwIfAborted();
    const matches = launchedWindows(await read(), name, target);
    signal?.throwIfAborted();
    // Titles, visibility and size do not prove which same-app window is the
    // requested document. Keep the choice explicit when siblings exist.
    if (matches.length > 1) return unavailable("ambiguous");
    const candidate = matches[0];
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

function launchName(app: string): string | undefined {
  return app
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.app$/i, "")
    .toLocaleLowerCase();
}

/** A desktop entry id names its app with or without the `.desktop` suffix. */
function withoutDesktopSuffix(name: string | undefined): string | undefined {
  return name?.replace(/\.desktop$/i, "");
}

/**
 * The windows this launch may have produced. Without an app identity the rule
 * is the one every backend always had: the pid when the launch reported one,
 * else the launch name against `appName`. With one, the pid still wins when any
 * window carries it — it is the stronger proof — and otherwise the identity or
 * the launch name may match, because the reported pid then belongs to a
 * process that was only ever going to hand the window on.
 */
function launchedWindows(
  windows: readonly ComputerWindow[],
  name: string | undefined,
  target: LaunchedWindowTarget | undefined,
): readonly ComputerWindow[] {
  const pid = target?.pid;
  if (target?.appId === undefined) {
    return windows.filter((window) =>
      pid !== undefined ? window.pid === pid : window.appName?.toLocaleLowerCase() === name,
    );
  }
  if (pid !== undefined) {
    const byPid = windows.filter((window) => window.pid === pid);
    if (byPid.length > 0) return byPid;
  }
  const names = new Set(
    [withoutDesktopSuffix(launchName(target.appId)), withoutDesktopSuffix(name)].filter(
      (entry): entry is string => entry !== undefined && entry.length > 0,
    ),
  );
  return windows.filter((window) => {
    const appName = withoutDesktopSuffix(window.appName?.toLocaleLowerCase());
    return appName !== undefined && names.has(appName);
  });
}
