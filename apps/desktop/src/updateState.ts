import type { DesktopUpdateState } from "@synara/contracts";

export type DownloadProgressSample = {
  readonly percent?: number | null;
  readonly transferred?: number | null;
};

export function getDownloadStallTimeoutMessage(timeoutMs: number): string {
  const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `Download stalled after ${timeoutSeconds} seconds without progress. Try again.`;
}

export function isExpectedStalledDownloadCancellationError(args: {
  readonly suppressionArmed: boolean;
  readonly errorContext: DesktopUpdateState["errorContext"];
  readonly message: string;
}): boolean {
  return (
    args.suppressionArmed &&
    args.errorContext === "download" &&
    args.message.trim().toLowerCase() === "cancelled"
  );
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function hasDownloadProgressAdvanced(
  previous: DownloadProgressSample | null,
  next: DownloadProgressSample,
): boolean {
  const nextTransferred = finiteNumber(next.transferred);
  const nextPercent = finiteNumber(next.percent);
  if (nextTransferred === null && nextPercent === null) {
    return false;
  }

  if (previous === null) {
    return true;
  }

  const previousTransferred = finiteNumber(previous.transferred);
  const previousPercent = finiteNumber(previous.percent);
  const transferredAdvanced =
    previousTransferred === null
      ? nextTransferred !== null
      : nextTransferred !== null && nextTransferred > previousTransferred;
  const percentAdvanced =
    previousPercent === null
      ? nextPercent !== null
      : nextPercent !== null && nextPercent > previousPercent;

  return transferredAdvanced || percentAdvanced;
}

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

  const previousStep = Math.floor(currentPercent);
  const nextStep = Math.floor(nextPercent);
  return nextStep !== previousStep || nextPercent === 100;
}

type ParsedUpdateVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
};

function parseUpdateVersion(version: string): ParsedUpdateVersion | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function isUpdateVersionNewer(currentVersion: string, candidateVersion: string): boolean {
  const current = parseUpdateVersion(currentVersion);
  const candidate = parseUpdateVersion(candidateVersion);
  if (!current || !candidate) {
    return candidateVersion.trim() !== currentVersion.trim();
  }

  if (candidate.major !== current.major) return candidate.major > current.major;
  if (candidate.minor !== current.minor) return candidate.minor > current.minor;
  if (candidate.patch !== current.patch) return candidate.patch > current.patch;

  // Treat stable as newer than the same prerelease, but never reinstall the
  // exact same stable version from a stale updater cache.
  return current.prerelease !== null && candidate.prerelease === null;
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
    return "Automatic updates are disabled by the SYNARA_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}
