// FILE: useDesktopNotchIsland.ts
// Purpose: The notch island toggle (macOS, Synara Beta) and where it may appear.
// Layer: Web hook over the desktop bridge
// Depends on: desktopBridge.notchIsland (absent in plain browsers and older desktop builds),
//             the account's billing status for Synara Alto.

import type { DesktopNotchIslandState } from "@synara/contracts";
import { NOTCH_ISLAND_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { isBetaFeatureOn } from "~/betaFeatures";
import { ACCOUNT_BILLING_ENABLED } from "~/lib/accountBilling";
import { accountBillingQueryOptions } from "~/lib/accountReactQuery";
import { isMacNavigatorPlatform } from "~/lib/utils";
import { useAccount } from "./useAccount";

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

/** The island checks Alto in the background; Settings' own reads stay fresh. */
const ALTO_ACCESS_STALE_MS = 10 * 60_000;

/**
 * Whether the account may use the island: Synara Alto wherever this build sells
 * it, everyone in builds without billing. Null while the account or its billing
 * is still loading. Desktop main keeps the island off until this reports true.
 */
export function useNotchIslandAltoAccess(active: boolean): boolean | null {
  const billingEnabled = ACCOUNT_BILLING_ENABLED;
  const account = useAccount();
  const billingOptions = accountBillingQueryOptions(account.status);
  const billing = useQuery({
    ...billingOptions,
    enabled: active && billingEnabled && billingOptions.enabled === true,
    staleTime: ALTO_ACCESS_STALE_MS,
  });
  if (!billingEnabled) return true;
  if (account.status === null) return null;
  if (account.status.state !== "signed-in") return false;
  // A failed refetch keeps the last answer; with none, the island stays off.
  if (billing.data) return billing.data.access === "granted";
  return billing.isError ? false : null;
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
