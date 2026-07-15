// FILE: desktopUpdate.logic.ts
// Purpose: Maps desktop updater state into sidebar button actions, copy, and variants.
// Layer: Web UI state helper
// Depends on: Desktop update IPC contracts.

import type { DesktopUpdateActionResult, DesktopUpdateState } from "@synara/contracts";

export type DesktopUpdateButtonAction = "check" | "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.status === "idle" ||
    state.status === "checking" ||
    state.status === "up-to-date" ||
    (state.status === "error" && state.errorContext === "check")
  ) {
    return "check";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "downloaded") {
    return "install";
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && !state.downloadedVersion && state.availableVersion) {
      return "download";
    }
    if (
      state.downloadedVersion &&
      (state.errorContext === "install" || state.errorContext === null)
    ) {
      return "install";
    }
    if (
      state.availableVersion &&
      (state.errorContext === "download" || state.errorContext === null)
    ) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state?.enabled) return false;
  // Only show the button when there's actually something to do:
  // a version being prepared, a downloaded update to install, or a retryable error.
  // Update checks stay background-only so periodic polling never flashes sidebar UI.
  const action = resolveDesktopUpdateButtonAction(state);
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "downloaded" ||
    (state.status === "error" && state.errorContext !== "check" && action !== "none")
  );
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return (
    state?.status === "downloading" ||
    state?.status === "checking" ||
    (state?.status === "available" && state.errorContext !== "download")
  );
}

export interface DesktopUpdateButtonPresentation {
  label: string;
  secondaryLabel: string | null;
}

export function getDesktopUpdateButtonPresentation(
  state: DesktopUpdateState | null,
  options?: { installing?: boolean },
): DesktopUpdateButtonPresentation {
  if (options?.installing) {
    return {
      label: "正在更新…",
      secondaryLabel: null,
    };
  }

  if (!state) {
    return {
      label: "更新",
      secondaryLabel: null,
    };
  }

  if (state.status === "checking") {
    return {
      label: "正在检查…",
      secondaryLabel: null,
    };
  }

  if (state.status === "downloading") {
    return {
      label: "正在准备",
      secondaryLabel: null,
    };
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    if (state.errorContext === "download" || state.errorContext === "install") {
      return {
        label: "重试",
        secondaryLabel: null,
      };
    }
    return {
      label: "正在准备",
      secondaryLabel: null,
    };
  }
  if (action === "install") {
    if (state.errorContext === "install") {
      return {
        label: "重试",
        secondaryLabel: null,
      };
    }
    return {
      label: "更新",
      secondaryLabel: null,
    };
  }
  if (action === "check") {
    return {
      label: "检查更新",
      secondaryLabel: null,
    };
  }
  return {
    label: "更新",
    secondaryLabel: null,
  };
}

export function getDesktopUpdateButtonLabel(state: DesktopUpdateState | null): string {
  return getDesktopUpdateButtonPresentation(state).label;
}

/**
 * Clamped, integer download percentage to surface on the update button while a
 * download is in flight. Returns null outside the downloading state or when the
 * updater has not reported a finite percentage yet.
 */
export function getDesktopUpdateDownloadPercent(state: DesktopUpdateState | null): number | null {
  if (!state || state.status !== "downloading") return null;
  const percent = state.downloadPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.floor(percent)));
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "当前安装包的架构正确。";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "这台 Mac 使用 Apple 芯片，但 Synara 仍在通过 Rosetta 运行 Intel 版本。Synara 正在准备原生 Apple 芯片版本更新。";
  }
  if (action === "install") {
    return "这台 Mac 使用 Apple 芯片，但 Synara 仍在通过 Rosetta 运行 Intel 版本。点击“更新”即可重启并切换到原生 Apple 芯片版本。";
  }
  return "这台 Mac 使用 Apple 芯片，但 Synara 仍在通过 Rosetta 运行 Intel 版本。下次应用更新会将其替换为原生 Apple 芯片版本。";
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  options?: { installing?: boolean },
): string {
  if (options?.installing) {
    return "正在应用更新…";
  }
  if (state.status === "idle") {
    return "检查更新";
  }
  if (state.status === "checking") {
    return "正在检查更新…";
  }
  if (state.status === "up-to-date") {
    return `当前已是 ${state.currentVersion} 最新版本。点击可再次检查。`;
  }
  if (state.errorContext === "install" && !state.downloadedVersion && state.availableVersion) {
    return `Synara 已重启，但未安装 ${state.availableVersion} 更新。点击可重试。`;
  }
  if (state.errorContext === "download" && state.availableVersion) {
    return `无法准备 ${state.availableVersion} 更新。点击可重试。`;
  }
  if (state.errorContext === "install" && (state.downloadedVersion || state.availableVersion)) {
    return `无法安装 ${state.downloadedVersion ?? state.availableVersion} 更新。点击可重试。`;
  }
  if (state.status === "available") {
    return `正在准备更新 ${state.availableVersion ?? ""}`.trim();
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `正在准备更新${progress}`;
  }
  if (state.status === "downloaded") {
    return `${state.downloadedVersion ?? state.availableVersion ?? ""} 更新已就绪。点击可重启并安装。`.trim();
  }
  if (state.status === "error") {
    if (state.errorContext === "check") {
      return state.message ? `${state.message}。点击可再次检查。` : "检查更新失败。点击可重试。";
    }
    if (state.errorContext === "download" && state.availableVersion) {
      return `无法准备 ${state.availableVersion} 更新。点击可重试。`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `无法安装 ${state.downloadedVersion} 更新。点击可重试。`;
    }
    return state.message ?? "更新失败";
  }
  return "有可用更新";
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return result.accepted && !result.completed;
}

// A download/install request can resolve to "up-to-date" when the offered version
// turned out not to be newer (stale updater state). That is not an error, so the UI
// should show an informational notice instead of silently resetting the button.
export function getDesktopUpdateAlreadyCurrentNotice(
  result: DesktopUpdateActionResult,
): string | null {
  if (result.completed || result.state.status !== "up-to-date") {
    return null;
  }
  return `You're already on the latest version (${result.state.currentVersion}).`;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state) return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function shouldRecommendManualDesktopDownload(state: DesktopUpdateState | null): boolean {
  return Boolean(state && state.installFailureCount >= 2 && state.releaseUrl);
}

// Stable identity for an in-app update failure, used to avoid toasting the same
// download/install error twice (e.g. once from the click handler and again when
// the install watchdog pushes the recovered state). Returns null for states that
// have no actionable manual-download fallback (checks, successes, in-progress).
export function getDesktopUpdateErrorSignature(state: DesktopUpdateState | null): string | null {
  if (!state || (state.errorContext !== "download" && state.errorContext !== "install")) {
    return null;
  }
  const version = state.downloadedVersion ?? state.availableVersion ?? "";
  return `${state.errorContext}:${version}:${state.installFailureCount}:${state.message ?? ""}`;
}

export type DesktopUpdateButtonVariant = "installing" | "ready" | "progress" | "error" | "info";

/**
 * Resolve the severity/color variant for the update button.
 *
 * A failed install keeps `status === "downloaded"` (with `errorContext === "install"`),
 * so the error state must be evaluated before the happy "downloaded"/"downloading"
 * states — otherwise a failed install would render with the green "ready" color while
 * its label says "Retry".
 */
export function getDesktopUpdateButtonVariant(
  state: DesktopUpdateState | null,
  options?: { installing?: boolean },
): DesktopUpdateButtonVariant {
  if (options?.installing) return "installing";
  if (shouldHighlightDesktopUpdateError(state)) return "error";
  if (state?.status === "downloaded") return "ready";
  if (state?.status === "downloading") return "progress";
  return "info";
}
