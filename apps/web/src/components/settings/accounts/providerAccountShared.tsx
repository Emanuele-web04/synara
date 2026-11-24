// FILE: providerAccountShared.tsx
// Purpose: What the Accounts list and the account editor share: the sign-in flow and its
//          dialog, the account settings writer, the "Default" badge, and the status tone
//          colors.
// Layer: Settings UI
// Exports: useProviderAccountSignIn, providerInstanceUpdater, DefaultAccountBadge,
//          ACCOUNT_STATUS_PILL_CLASS_NAME, ACCOUNT_STATUS_DOT_CLASS_NAME

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import {
  buildProviderInstanceSettingsPatch,
  type AppSettings,
  type ProviderInstanceOption,
  type ProviderInstancePatch,
} from "~/appSettings";
import { useTranslation } from "~/i18n";
import type { ProviderAccountStatusTone } from "~/lib/providerSetupStatus";

import { toastManager } from "../../ui/toast";

const ProviderSignInDialog = lazy(() => import("./ProviderSignInDialog"));

export const ACCOUNT_STATUS_PILL_CLASS_NAME: Record<ProviderAccountStatusTone, string> = {
  ready: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  error: "bg-red-500/12 text-red-700 dark:text-red-300",
  idle: "bg-muted text-muted-foreground",
};

export const ACCOUNT_STATUS_DOT_CLASS_NAME: Record<ProviderAccountStatusTone, string> = {
  ready: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-muted-foreground/40",
};

/** Marks an agent's default account beside its name. */
export function DefaultAccountBadge() {
  const { t } = useTranslation();

  return (
    <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-ui-2xs font-medium text-muted-foreground">
      {t("settings:reasoningModes_default")}
    </span>
  );
}

/** Writes one account's patch, routing a migrated Codex account to its saved entry. */
export function providerInstanceUpdater(
  settings: AppSettings,
  updateSettings: (patch: Partial<AppSettings>) => void,
) {
  return (
    instanceId: string,
    patch: ProviderInstancePatch,
    legacyCodexAccountId: string | null = null,
  ) => {
    const settingsPatch = buildProviderInstanceSettingsPatch(
      settings,
      instanceId,
      patch,
      legacyCodexAccountId,
    );
    if (settingsPatch) updateSettings(settingsPatch);
  };
}

/** The part of an account the sign-in dialog needs. */
export type ProviderSignInAccount = Pick<
  ProviderInstanceOption,
  "provider" | "instanceId" | "label"
> &
  Partial<ProviderInstanceOption>;

/**
 * Starts an account's sign-in once its pending settings are saved, and owns the sign-in
 * dialog. Render `signInDialog` wherever the caller lays out its content.
 */
export function useProviderAccountSignIn(
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>,
  options?: {
    /** Close the dialog as soon as the account is confirmed signed in. */
    readonly closeWhenAuthenticated?: boolean;
    /** Runs after the dialog closes, whatever the outcome. */
    readonly onClosed?: () => void;
  },
): {
  /** Resolves true once the sign-in dialog is open, false when it could not start. */
  startSignIn: (account: ProviderSignInAccount) => Promise<boolean>;
  startingSignIn: boolean;
  signInDialog: ReactNode;
} {
  const { t } = useTranslation();

  const [signInAccount, setSignInAccount] = useState<ProviderSignInAccount | null>(null);
  const onClosedRef = useRef(options?.onClosed);
  onClosedRef.current = options?.onClosed;
  const [startingSignIn, setStartingSignIn] = useState(false);
  const signInPendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const startSignIn = async (account: ProviderSignInAccount) => {
    if (signInPendingRef.current) return false;
    signInPendingRef.current = true;
    setStartingSignIn(true);
    try {
      // This is queued behind edits already being saved; the server must see
      // the account's latest settings before it resolves the login environment.
      await updateSettingsAndWait({});
      if (mountedRef.current) setSignInAccount(account);
      return mountedRef.current;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:unableToStartSignIn"),
        description:
          error instanceof Error ? error.message : t("settings:unableToSaveProviderSettings"),
      });
      return false;
    } finally {
      signInPendingRef.current = false;
      if (mountedRef.current) setStartingSignIn(false);
    }
  };

  const signInDialog = signInAccount ? (
    <Suspense
      fallback={<p className="text-ui-sm text-muted-foreground">{t("settings:openingSignIn")}</p>}
    >
      <ProviderSignInDialog
        provider={signInAccount.provider}
        instanceId={String(signInAccount.instanceId)}
        accountLabel={signInAccount.label}
        closeWhenAuthenticated={options?.closeWhenAuthenticated === true}
        onClose={() => {
          setSignInAccount(null);
          onClosedRef.current?.();
        }}
      />
    </Suspense>
  ) : null;

  return { startSignIn, startingSignIn, signInDialog };
}
