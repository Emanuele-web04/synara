// Purpose: Desktop auto-update button state, subscription, and click handler extracted from Sidebar.tsx.
// Layer: web hook (client-side orchestration). Owns the desktop-update state machine; returns derived presentation.
// Exports: useSidebarDesktopUpdate, SidebarDesktopUpdate.

import { useCallback, useEffect, useState } from "react";
import { type DesktopUpdateState } from "@t3tools/contracts";
import { isElectron } from "../env";
import { persistAppStateNow } from "../store";
import { cn } from "~/lib/utils";
import { toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateAlreadyCurrentNotice,
  getDesktopUpdateButtonPresentation,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateButtonVariant,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

export interface SidebarDesktopUpdate {
  showDesktopUpdateButton: boolean;
  desktopUpdateTooltip: string;
  desktopUpdateButtonDisabled: boolean;
  desktopUpdateButtonAction: ReturnType<typeof resolveDesktopUpdateButtonAction> | "none";
  desktopUpdateButtonPresentation: ReturnType<typeof getDesktopUpdateButtonPresentation>;
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateRowButtonClasses: string;
  handleDesktopUpdateButtonClick: () => void;
}

export function useSidebarDesktopUpdate(): SidebarDesktopUpdate {
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installingDesktopUpdate, setInstallingDesktopUpdate] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);

  const desktopUpdateTooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState, {
        installing: installingDesktopUpdate,
      })
    : "Update available";

  const desktopUpdateButtonDisabled =
    isDesktopUpdateButtonDisabled(desktopUpdateState) || installingDesktopUpdate;
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const desktopUpdateButtonPresentation = getDesktopUpdateButtonPresentation(desktopUpdateState, {
    installing: installingDesktopUpdate,
  });
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const desktopUpdateButtonInteractivityClasses = desktopUpdateButtonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:brightness-110";
  const desktopUpdateButtonVariant = getDesktopUpdateButtonVariant(desktopUpdateState, {
    installing: installingDesktopUpdate,
  });
  const desktopUpdateButtonClasses =
    desktopUpdateButtonVariant === "installing" || desktopUpdateButtonVariant === "progress"
      ? "bg-sky-500 hover:bg-sky-600"
      : desktopUpdateButtonVariant === "ready"
        ? "bg-emerald-500 hover:bg-emerald-600"
        : desktopUpdateButtonVariant === "error"
          ? "bg-rose-500 hover:bg-rose-600"
          : "bg-[var(--info)] hover:brightness-110";
  const desktopUpdateButtonHasSecondaryLabel =
    desktopUpdateButtonPresentation.secondaryLabel !== null;
  const desktopUpdateRowButtonClasses = cn(
    "inline-flex shrink-0 items-center justify-between gap-2 rounded-full px-2.5 text-center text-white transition-colors",
    desktopUpdateButtonHasSecondaryLabel ? "min-h-6 py-1" : "h-6",
    desktopUpdateButtonInteractivityClasses,
    desktopUpdateButtonClasses,
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    // Keep the sidebar action as the single visible entry point for manual checks.
    if (desktopUpdateButtonAction === "check") {
      void bridge
        .checkForUpdates()
        .then((nextState) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(nextState);
          if (nextState.status === "available") {
            toastManager.add({
              type: "success",
              title: "Update available",
              description: `Version ${nextState.availableVersion ?? "available"} is ready to download.`,
            });
            return;
          }

          if (nextState.status === "up-to-date") {
            toastManager.add({
              type: "info",
              title: "You're up to date",
              description: `Synara ${nextState.currentVersion} is already the newest version.`,
            });
            return;
          }

          if (nextState.status === "error") {
            toastManager.add({
              type: "error",
              title: "Could not check for updates",
              description: nextState.message ?? "An unexpected error occurred.",
            });
          }
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(result.state);
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: "Already up to date",
              description: alreadyCurrentNotice,
            });
            return;
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      setInstallingDesktopUpdate(true);
      persistAppStateNow();
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateState(result.state);
          setInstallingDesktopUpdate(false);
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: "Already up to date",
              description: alreadyCurrentNotice,
            });
            return;
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          setInstallingDesktopUpdate(false);
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  return {
    showDesktopUpdateButton,
    desktopUpdateTooltip,
    desktopUpdateButtonDisabled,
    desktopUpdateButtonAction,
    desktopUpdateButtonPresentation,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateRowButtonClasses,
    handleDesktopUpdateButtonClick,
  };
}
