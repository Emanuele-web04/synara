import type { DesktopUpdateState } from "@t3tools/contracts";

export function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

export function nextStatusAfterDownloadFailure(
  currentState: DesktopUpdateState,
): DesktopUpdateState["status"] {
  return currentState.availableVersion ? "available" : "error";
}

export function getCanRetryAfterDownloadFailure(currentState: DesktopUpdateState): boolean {
  return currentState.availableVersion !== null;
}

export function shouldCheckForUpdatesOnForeground(args: {
  checkedAt: string | null;
  backgroundedAtMs: number | null;
  foregroundedAtMs: number;
  minBackgroundDurationMs: number;
  minIntervalMs: number;
}): boolean {
  const { checkedAt, backgroundedAtMs, foregroundedAtMs, minBackgroundDurationMs, minIntervalMs } =
    args;
  if (backgroundedAtMs === null || foregroundedAtMs <= backgroundedAtMs) {
    return false;
  }

  // Ignore fleeting blur/focus churn from window transitions and native dialogs.
  if (foregroundedAtMs - backgroundedAtMs < minBackgroundDurationMs) {
    return false;
  }

  if (checkedAt === null) {
    return true;
  }

  const lastCheckedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(lastCheckedAtMs)) {
    return true;
  }

  return foregroundedAtMs - lastCheckedAtMs >= minIntervalMs;
}

export function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}
