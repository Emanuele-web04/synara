// Owns desktop updater transitions, including staged updates retained across later checks.
// main.ts owns transfers and artifact verification before publishing download completion.
import type { DesktopRuntimeInfo, DesktopUpdateState } from "@synara/contracts";

import {
  getCanRetryAfterDownloadFailure,
  isUpdateVersionAllowedForFlavor,
  isUpdateVersionNewer,
  nextStatusAfterDownloadFailure,
} from "./updateState";

export function createInitialDesktopUpdateState(
  currentVersion: string,
  runtimeInfo: DesktopRuntimeInfo,
  flavor: DesktopUpdateState["flavor"] = "production",
): DesktopUpdateState {
  return {
    enabled: false,
    status: "disabled",
    currentVersion,
    hostArch: runtimeInfo.hostArch,
    appArch: runtimeInfo.appArch,
    runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    installFailureCount: 0,
    flavor,
    releaseUrl: null,
  };
}

export function reduceDesktopUpdateStateOnCheckStart(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "checking",
    checkedAt,
    message: null,
    downloadPercent: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnCheckFailure(
  state: DesktopUpdateState,
  message: string,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: state.downloadedVersion === null ? "error" : "downloaded",
    message,
    checkedAt,
    downloadPercent: state.downloadedVersion === null ? null : 100,
    errorContext: "check",
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnUpdateAvailable(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string,
): DesktopUpdateState {
  // The feed compares against the running app, so it may offer the already-staged release.
  if (state.downloadedVersion !== null && !isUpdateVersionNewer(state.downloadedVersion, version)) {
    return {
      ...state,
      status: "downloaded",
      checkedAt,
      downloadPercent: 100,
      canRetry: true,
    };
  }
  const installFailureCount = state.availableVersion === version ? state.installFailureCount : 0;
  return {
    ...state,
    status: "available",
    availableVersion: version,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
    installFailureCount,
  };
}

export function reduceDesktopUpdateStateOnNoUpdate(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  // A withdrawn or temporarily stale feed does not invalidate a verified pending payload.
  if (
    state.downloadedVersion !== null &&
    isUpdateVersionNewer(state.currentVersion, state.downloadedVersion) &&
    isUpdateVersionAllowedForFlavor(state.downloadedVersion, state.flavor)
  ) {
    return {
      ...state,
      status: "downloaded",
      downloadPercent: 100,
      checkedAt,
      message: null,
      errorContext: null,
      canRetry: true,
    };
  }
  return {
    ...state,
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
    installFailureCount: 0,
  };
}

export function reduceDesktopUpdateStateOnDownloadStart(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: nextStatusAfterDownloadFailure(state),
    downloadedVersion: null,
    message,
    downloadPercent: null,
    errorContext: "download",
    canRetry: getCanRetryAfterDownloadFailure(state),
  };
}

export function reduceDesktopUpdateStateOnDownloadProgress(
  state: DesktopUpdateState,
  percent: number,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: percent,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadComplete(
  state: DesktopUpdateState,
  version: string,
): DesktopUpdateState {
  // A cancelled transfer can finish fingerprinting after a newer target has been selected.
  if (state.status !== "downloading" || state.availableVersion !== version) return state;
  return {
    ...state,
    status: "downloaded",
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: true,
    installFailureCount: state.availableVersion === version ? state.installFailureCount : 0,
  };
}

export function reduceDesktopUpdateStateOnInstallStart(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return { ...state, message: null, errorContext: null, canRetry: false };
}

export function reduceDesktopUpdateStateOnInstallFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    message,
    errorContext: "install",
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnInstallRestartFailure(
  state: DesktopUpdateState,
  toVersion: string,
  consecutiveFailures: number,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "error",
    availableVersion: toVersion,
    downloadedVersion: null,
    downloadPercent: null,
    message,
    errorContext: "install",
    canRetry: true,
    installFailureCount: consecutiveFailures,
  };
}
