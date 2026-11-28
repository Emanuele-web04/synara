// FILE: useCustomTitleBarPreference.ts
// Purpose: The Windows/Linux "use custom title bar" and "rounded window corners"
//          preferences: whether they apply here, whether a restart is pending, and how
//          to save them through the desktop bridge.
//          Shared by Settings › Appearance and Restore defaults.
// Layer: Settings hook
// Exports: useCustomTitleBarPreference

import type { DesktopCustomTitleBarState } from "@synara/contracts";

import type { AppSettingsBinding } from "~/appSettings";
import { toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { useTranslation } from "~/i18n";
import { getNavigatorPlatform, isLinuxPlatform, isWindowsPlatform } from "~/lib/utils";
import { useDesktopCustomTitleBarState } from "./useDesktopCustomTitleBar";

export function useCustomTitleBarPreference({
  settings,
  defaults,
  updateSettings,
}: AppSettingsBinding) {
  const { t } = useTranslation();
  const platform = getNavigatorPlatform();
  const supported = isElectron && (isWindowsPlatform(platform) || isLinuxPlatform(platform));
  const state = useDesktopCustomTitleBarState();
  const restartRequired = state.supported && settings.useCustomTitleBar !== state.active;
  const preferenceDirty =
    supported &&
    (settings.useCustomTitleBar !== defaults.useCustomTitleBar ||
      (state.supported && state.preference !== defaults.useCustomTitleBar));
  // Corners only exist on the frameless window, so they need no restart with the system frame.
  const roundedCornersRestartRequired =
    state.supported &&
    state.active &&
    settings.useCustomTitleBar &&
    settings.useRoundedWindowCorners !== state.roundedCornersActive;
  const roundedCornersDirty =
    supported &&
    (settings.useRoundedWindowCorners !== defaults.useRoundedWindowCorners ||
      (state.supported && state.roundedCornersPreference !== defaults.useRoundedWindowCorners));

  function showRestartToast(
    title:
      | "settings:restartToApplyTitleBar"
      | "settings:restartToApplyWindowCorners" = "settings:restartToApplyTitleBar",
  ): void {
    toastManager.add({
      type: "warning",
      title: t(title),
      description: t("settings:theWindowFrameUpdatesTheNextTimeSynaraLaunches"),
      actionProps: {
        "aria-label": t("settings:restartSynara"),
        children: t("settings:restartAction"),
        onClick: () => {
          void window.desktopBridge?.customTitleBar?.relaunch();
        },
      },
    });
  }

  async function persist(enabled: boolean): Promise<{ readonly restartRequired: boolean } | null> {
    return save(
      (bridge) => bridge.setPreference(enabled),
      (next) => next.preference === enabled,
    );
  }

  async function persistRoundedCorners(
    enabled: boolean,
  ): Promise<{ readonly restartRequired: boolean } | null> {
    return save(
      (bridge) => bridge.setRoundedCorners(enabled),
      (next) => next.roundedCornersPreference === enabled,
    );
  }

  async function save(
    write: (
      bridge: NonNullable<NonNullable<typeof window.desktopBridge>["customTitleBar"]>,
    ) => Promise<DesktopCustomTitleBarState>,
    saved: (next: DesktopCustomTitleBarState) => boolean,
  ): Promise<{ readonly restartRequired: boolean } | null> {
    try {
      const bridge = window.desktopBridge?.customTitleBar;
      if (!bridge) throw new Error("Desktop title bar bridge is unavailable.");
      const next = await write(bridge);
      if (!next.supported || !saved(next)) {
        throw new Error("Desktop title bar preference was not persisted.");
      }
      return next;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:couldNotUpdateTitleBar"),
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Save the preference, rolling the setting back when the desktop app refuses it. */
  async function apply(enabled: boolean): Promise<void> {
    const previous = settings.useCustomTitleBar;
    updateSettings({ useCustomTitleBar: enabled });
    const next = await persist(enabled);
    if (next === null) {
      updateSettings({ useCustomTitleBar: previous });
      return;
    }
    if (next.restartRequired) showRestartToast();
  }

  async function applyRoundedCorners(enabled: boolean): Promise<void> {
    const previous = settings.useRoundedWindowCorners;
    updateSettings({ useRoundedWindowCorners: enabled });
    const next = await persistRoundedCorners(enabled);
    if (next === null) {
      updateSettings({ useRoundedWindowCorners: previous });
      return;
    }
    if (next.restartRequired) showRestartToast("settings:restartToApplyWindowCorners");
  }

  return {
    supported,
    restartRequired,
    preferenceDirty,
    roundedCornersRestartRequired,
    roundedCornersDirty,
    persist,
    persistRoundedCorners,
    apply,
    applyRoundedCorners,
    showRestartToast,
  };
}
