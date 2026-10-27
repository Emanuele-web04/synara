// FILE: AdvancedSettingsPanel.tsx
// Purpose: Own advanced settings state and workflows for auth, keybindings, and recovery.
// Layer: Settings UI components
// Exports: AdvancedSettingsPanel

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { logoutCurrentBrowserSession } from "~/authLogout";
import { useFeatureTourStore } from "~/featureTour/store";
import { APP_VERSION } from "~/branding";
import { resolveAndPersistPreferredEditor } from "~/editorPreferences";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { serverAuthSessionQueryOptions, serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { SETTINGS_INSET_LIST_CLASS_NAME } from "~/settingsPanelStyles";
import { useStore } from "~/store";
import { createAllThreadsMessagelessSelector, createThreadShellsSelector } from "~/storeSelectors";
import { useSettingsRestoreSignal } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

export function AdvancedSettingsPanel(props: {
  active: boolean;
  onOpenReleaseHistory: () => void;
  resetEpoch: number;
}) {
  const { t } = useTranslation();

  const configQuery = useQuery(serverConfigQueryOptions());
  const authSessionQuery = useQuery(serverAuthSessionQueryOptions());
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  // Keep these subscriptions inside the only panel that uses recovery eligibility.
  const threadShells = useStore(useMemo(() => createThreadShellsSelector(), []));
  const allThreadsMessageless = useStore(useMemo(() => createAllThreadsMessagelessSelector(), []));
  const projectCount = useStore((store) => store.projects.length);
  const threadsHydrated = useStore((store) => store.threadsHydrated);

  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [isRepairingLocalState, setIsRepairingLocalState] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showRecoveryTools, setShowRecoveryTools] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);

  useSettingsRestoreSignal(props.resetEpoch, () => {
    setShowRecoveryTools(false);
    setOpenKeybindingsError(null);
  });

  const keybindingsConfigPath = configQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = configQuery.data?.availableEditors;
  const shouldOfferRecoveryTools = useMemo(() => {
    if (!threadsHydrated || projectCount === 0) return false;
    return threadShells.length === 0 || allThreadsMessageless;
  }, [allThreadsMessageless, projectCount, threadShells.length, threadsHydrated]);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError(t("settings:common_noAvailableEditors"));
      setIsOpeningKeybindings(false);
      return;
    }
    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : t("settings:unableToOpenKeybindingsFile"),
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath, t]);

  const repairLocalState = useCallback(async () => {
    if (isRepairingLocalState) return;
    const api = readNativeApi() ?? ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      [
        "Repair local state?",
        "This rebuilds local project indexes and refreshes project snapshots.",
        "It keeps existing chats in place, but it may take a moment.",
      ].join("\n"),
    );
    if (!confirmed) return;

    setIsRepairingLocalState(true);
    await api.orchestration
      .repairState()
      .then((snapshot) => {
        syncServerReadModel(snapshot);
        toastManager.add({
          type: "success",
          title: t("settings:localStateRepaired"),
          description: t("settings:projectIndexesWereRebuiltWithoutClearingExistingChats"),
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: t("settings:advanced_repairFailed"),
          description:
            error instanceof Error ? error.message : t("settings:unableToRepairLocalState"),
        });
      })
      .finally(() => {
        setIsRepairingLocalState(false);
      });
  }, [isRepairingLocalState, syncServerReadModel, t]);

  const logoutCurrentSession = useCallback(async () => {
    if (isLoggingOut) return;
    const api = readNativeApi() ?? ensureNativeApi();
    setIsLoggingOut(true);
    const result = await logoutCurrentBrowserSession({
      confirm: () => api.dialogs.confirm(t("settings:signOutThisBrowserItsSessionAndEveryLive")),
      logout: () => api.server.logoutAuthSession(),
      navigate: (path) => window.location.assign(path),
      onError: (error) =>
        toastManager.add({
          type: "error",
          title: t("settings:signOutFailed"),
          description:
            error instanceof Error ? error.message : t("settings:unableToRevokeThisSession"),
        }),
    });
    if (result !== "redirecting") setIsLoggingOut(false);
  }, [isLoggingOut, t]);

  if (!props.active) return null;

  return (
    <div className="space-y-6">
      {authSessionQuery.data?.authenticated ? (
        <SettingsSection title="settings:session">
          <SettingsRow
            id="setting-this-browser"
            title="settings:thisBrowser"
            description="settings:revokeThisBrowserSessionAndCloseEveryLiveSynara"
            status={`Authenticated as ${authSessionQuery.data.role ?? "client"}.`}
            control={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={isLoggingOut}
                onClick={() => void logoutCurrentSession()}
              >
                {isLoggingOut ? t("settings:signingOut") : t("settings:signOut")}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="settings:advanced_developerTools">
        <SettingsRow
          id="setting-keybindings"
          title="common:advanced_keybindings"
          description="settings:openThePersistedKeybindingsJsonFileToEditAdvanced"
          status={
            <>
              <span className="block break-all font-mono text-ui-sm text-foreground">
                {keybindingsConfigPath ?? t("settings:advanced_resolvingKeybindingsPath")}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">{t("settings:advanced_opensInEditor")}</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings
                ? t("settings:advanced_opening")
                : t("settings:advanced_openFile")}
            </Button>
          }
        />

        <SettingsRow
          id="setting-recovery-tools"
          title="settings:advanced_recoveryTools"
          description="settings:advanced_recoveryToolsDescription"
          status={
            shouldOfferRecoveryTools
              ? "Visible because projects exist but no chat history is currently available."
              : "Shown automatically only when recovery actions are relevant."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!shouldOfferRecoveryTools || isRepairingLocalState}
              onClick={() => void repairLocalState()}
            >
              {isRepairingLocalState
                ? t("settings:advanced_repairing")
                : t("settings:advanced_repairState")}
            </Button>
          }
        >
          {shouldOfferRecoveryTools ? (
            <div className="mt-3 border-t border-border/70 pt-3">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                aria-expanded={showRecoveryTools}
                onClick={() => setShowRecoveryTools((current) => !current)}
              >
                <span className="text-ui leading-snug font-medium text-muted-foreground">
                  {t("settings:advanced_whatThisDoes")}
                </span>
                <DisclosureChevron
                  open={showRecoveryTools}
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </button>
              <DisclosureRegion
                open={showRecoveryTools}
                contentClassName={cn(
                  "mt-3 px-3 py-3 text-ui leading-snug text-muted-foreground",
                  SETTINGS_INSET_LIST_CLASS_NAME,
                )}
              >
                <div>{t("settings:advanced_recoveryDetail")}</div>
              </DisclosureRegion>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="settings:advanced_about">
        <SettingsRow
          id="setting-version"
          title="settings:advanced_version"
          description="settings:advanced_versionDescription"
          control={
            <code className="text-ui leading-snug font-medium text-muted-foreground">
              {APP_VERSION}
            </code>
          }
        />
        <SettingsRow
          id="setting-what-s-new-since-0-9-2"
          title="settings:whatSNewSince092"
          description="settings:exploreTheRedesignedWorkspaceProviderAccountsAndCodeReview"
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => useFeatureTourStore.getState().open()}
            >
              {t("settings:replayFeatureTour")}
            </Button>
          }
        />
        <SettingsRow
          id="setting-release-history"
          title="common:advanced_releaseHistory"
          description="settings:advanced_releaseHistoryDescription"
          control={
            <Button size="sm" variant="outline" onClick={props.onOpenReleaseHistory}>
              {t("settings:advanced_viewReleaseHistory")}
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );
}
