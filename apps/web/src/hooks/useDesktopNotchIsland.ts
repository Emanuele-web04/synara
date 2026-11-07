// FILE: useDesktopNotchIsland.ts
// Purpose: The notch island toggle (macOS, Synara Beta) and where it may appear.
// Layer: Web hook over the desktop bridge
// Depends on: desktopBridge.notchIsland (absent in plain browsers and older desktop builds).

import type { DesktopNotchIslandState } from "@synara/contracts";
import { NOTCH_ISLAND_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { useCallback, useEffect, useState } from "react";

import { isBetaFeatureOn } from "~/betaFeatures";
import { isMacNavigatorPlatform } from "~/lib/utils";

/**
 * Whether this host may show the notch island's entry points. Desktop main
 * re-checks platform and flavor, so this only hides them.
 */
export function isNotchIslandAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    isMacNavigatorPlatform() &&
    window.desktopBridge?.notchIsland !== undefined &&
    isBetaFeatureOn(NOTCH_ISLAND_BETA_FEATURE)
  );
}

export interface DesktopNotchIsland {
  /** Null until the bridge answers, and always null where the island is unavailable. */
  readonly state: DesktopNotchIslandState | null;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
}

export function useDesktopNotchIsland(): DesktopNotchIsland {
  const [state, setState] = useState<DesktopNotchIslandState | null>(null);

  useEffect(() => {
    if (!isNotchIslandAvailable()) return;
    const bridge = window.desktopBridge?.notchIsland;
    if (!bridge) return;
    let cancelled = false;
    void bridge.getState().then(
      (next) => {
        if (!cancelled) setState(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    const bridge = window.desktopBridge?.notchIsland;
    if (!bridge) return;
    setState((current) => (current ? { ...current, enabled } : current));
    try {
      setState(await bridge.setEnabled(enabled));
    } catch (error) {
      setState((current) => (current ? { ...current, enabled: !enabled } : current));
      throw error;
    }
  }, []);

  return { state, setEnabled };
}
