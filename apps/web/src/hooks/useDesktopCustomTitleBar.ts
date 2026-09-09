// FILE: useDesktopCustomTitleBar.ts
// Purpose: Track the live Electron caption-control mode and title-bar preference.
// Layer: Shared web shell chrome
// Depends on: desktop bridge customTitleBar IPC.

import { useEffect, useState } from "react";

import type { DesktopCustomTitleBarMode, DesktopCustomTitleBarState } from "@synara/contracts";

import { isElectron } from "~/env";
import { getNavigatorPlatform, isLinuxPlatform, isWindowsPlatform } from "~/lib/utils";

const DEFAULT_STATE: DesktopCustomTitleBarState = {
  supported: false,
  preference: true,
  active: false,
  restartRequired: false,
  mode: "native-frame",
};

/**
 * Optimistic default before the bridge replies. Matches the shared platform
 * default (custom title bar on for Windows/Linux) so the correct native or
 * renderer gutter appears without a one-frame flash on the common path.
 */
export function initialDesktopCustomTitleBarMode(): DesktopCustomTitleBarMode {
  if (!isElectron) return "native-frame";
  const platform = getNavigatorPlatform();
  if (isWindowsPlatform(platform)) return "native-overlay";
  if (isLinuxPlatform(platform)) return "renderer";
  return "native-frame";
}

export function useDesktopCustomTitleBarState(): DesktopCustomTitleBarState {
  const [state, setState] = useState<DesktopCustomTitleBarState>(() => {
    const mode = initialDesktopCustomTitleBarMode();
    const active = mode !== "native-frame";
    return {
      ...DEFAULT_STATE,
      active,
      supported: active,
      mode,
    };
  });

  useEffect(() => {
    const bridge = window.desktopBridge?.customTitleBar;
    if (!bridge) return;
    let cancelled = false;

    void bridge.getState().then((next) => {
      if (!cancelled) setState(next);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function useDesktopCustomTitleBarActive(): boolean {
  return useDesktopCustomTitleBarState().active;
}

export function useDesktopCustomTitleBarMode(): DesktopCustomTitleBarMode {
  return useDesktopCustomTitleBarState().mode;
}
