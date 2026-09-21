// FILE: AppSnapWelcomeDialog.tsx
// Purpose: Introduce AppSnap once on supported desktop installs and route users
// directly to its opt-in setup panel.
// Layer: Root web overlay
//
// Rendered through the shared AnnouncementSheet.

import { Schema } from "effect";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { CentralIcon } from "../lib/central-icons";
import { AnnouncementSheet } from "./AnnouncementSheet";

const APP_SNAP_WELCOME_STORAGE_KEY = "synara:appsnap-welcome:v1";

const AppSnapWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type AppSnapWelcomeStorage = typeof AppSnapWelcomeStorageSchema.Type;

const INITIAL_STORAGE: AppSnapWelcomeStorage = { acknowledged: false };

export function AppSnapWelcomeDialog() {
  const navigate = useNavigate();
  const [storage, setStorage] = useLocalStorage(
    APP_SNAP_WELCOME_STORAGE_KEY,
    INITIAL_STORAGE,
    AppSnapWelcomeStorageSchema,
  );
  const [open, setOpen] = useState(false);
  // Both startup dialogs probe asynchronously; without arbitration a fresh macOS install
  // could stack this sheet on the welcome tour. Wait for the tour's gate and its close.
  const onboardingBlocking = useOnboardingDialogStore(
    (store) => !store.startupGateSettled || store.isOpen,
  );

  useEffect(() => {
    if (storage.acknowledged) {
      return;
    }

    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;

    let disposed = false;
    void bridge
      .getState()
      .then((state) => {
        if (!disposed && state.supported) setOpen(true);
      })
      .catch((error) => {
        // Do not acknowledge a failed probe: a transient desktop startup issue
        // should not permanently hide the introduction on the next launch.
        console.warn("[appsnap] Could not check welcome-dialog support", error);
      });

    return () => {
      disposed = true;
    };
  }, [storage.acknowledged]);

  const acknowledge = () => {
    setOpen(false);
    setStorage({ acknowledged: true });
  };

  const openSettings = () => {
    acknowledge();
    void navigate({ to: "/settings", search: { section: "appsnap" } });
  };

  // Derived instead of synced: acknowledging closes the dialog in the same
  // render, so the effect never needs a synchronous setOpen(false).
  const dialogOpen = open && !storage.acknowledged && !onboardingBlocking;

  return (
    <AnnouncementSheet
      open={dialogOpen}
      hero={
        // Same glyph as the AppSnap settings panel this dialog links to.
        <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--color-border)] bg-muted/30 text-foreground">
          <CentralIcon name="screen-capture" className="size-8" />
        </span>
      }
      title="Synara AppSnaps are live!"
      description={
        <>
          Press both Option keys (⌥&thinsp;⌥) to snap any app&rsquo;s window into the task
          you&rsquo;re working in.
        </>
      }
      dismissLabel="Not now"
      confirmLabel="Set up AppSnap"
      onDismiss={acknowledge}
      onConfirm={openSettings}
    />
  );
}
