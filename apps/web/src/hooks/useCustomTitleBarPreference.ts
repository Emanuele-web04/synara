// FILE: useCustomTitleBarPreference.ts
// Purpose: The Windows/Linux "use custom title bar" preference: whether it applies here,
//          whether a restart is pending, and how to save it through the desktop bridge.
//          Shared by Settings › Appearance and Restore defaults.
// Layer: Settings hook
// Exports: useCustomTitleBarPreference

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

  function showRestartToast(): void {
    toastManager.add({
      type: "warning",
      title: t("settings:restartToApplyTitleBar"),
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
    try {
      const bridge = window.desktopBridge?.customTitleBar;
      if (!bridge) throw new Error("Desktop title bar bridge is unavailable.");
      const next = await bridge.setPreference(enabled);
      if (!next.supported || next.preference !== enabled) {
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

  return { supported, restartRequired, preferenceDirty, persist, apply, showRestartToast };
}
