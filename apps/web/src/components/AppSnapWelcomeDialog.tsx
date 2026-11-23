// FILE: AppSnapWelcomeDialog.tsx
// Purpose: Introduce AppSnap once on supported desktop installs and route users
// directly to its opt-in setup panel.
// Layer: Root web overlay
//
// Rendered through the shared AnnouncementSheet.

import { Schema } from "effect";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { cn } from "~/lib/utils";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { AnnouncementSheet } from "./AnnouncementSheet";
import { DIALOG_HERO_ITEM_SHADOW_CLASS_NAME } from "./DialogHeroBand";
import { useTranslation } from "~/i18n";

const APP_SNAP_WELCOME_STORAGE_KEY = "synara:appsnap-welcome:v1";

const AppSnapWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type AppSnapWelcomeStorage = typeof AppSnapWelcomeStorageSchema.Type;

const INITIAL_STORAGE: AppSnapWelcomeStorage = { acknowledged: false };

export function AppSnapWelcomeDialog({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();

  const navigate = useNavigate();
  const [storage, setStorage] = useLocalStorage(
    APP_SNAP_WELCOME_STORAGE_KEY,
    INITIAL_STORAGE,
    AppSnapWelcomeStorageSchema,
  );
  const [open, setOpen] = useState(false);
  const [probeSettled, setProbeSettled] = useState(false);
  const handedOff = useAnnouncementSheetSlotStore((state) => state.handedOff);
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
      })
      .finally(() => {
        if (!disposed) setProbeSettled(true);
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
    <>
      {(storage.acknowledged || !window.desktopBridge?.appSnap || probeSettled) &&
      (!dialogOpen || handedOff)
        ? children
        : null}
      <AnnouncementSheet
        open={dialogOpen}
        hero={<AppSnapScene />}
        title={t("common:synaraAppSnapsAreLive")}
        description={t("common:pressBothOptionKeysToSnapAnyAppS")}
        dismissLabel={t("common:notNow")}
        confirmLabel={t("common:setUpAppSnap")}
        onDismiss={acknowledge}
        onConfirm={openSettings}
      />
    </>
  );
}

/** Both Option keys pressed, a window framed, and the snap landing in the chat. */
function AppSnapScene() {
  const { t } = useTranslation();
  return (
    <div className="relative h-full w-[340px]">
      <div className="absolute top-12 start-2 flex gap-1.5">
        {[0, 1].map((key) => (
          <span
            key={key}
            className="scene-keypress flex size-11 items-end justify-end rounded-[10px] border border-b-[3px] border-border bg-popover px-2 py-1.5 text-ui-lg leading-none text-foreground"
            style={{ animationDelay: `${key * 60}ms` }}
          >
            ⌥
          </span>
        ))}
      </div>
      <div
        className={cn(
          "absolute top-6 start-[118px] flex h-[118px] w-[188px] flex-col overflow-hidden rounded-xl border border-border bg-popover",
          DIALOG_HERO_ITEM_SHADOW_CLASS_NAME,
        )}
      >
        <span className="flex h-5 shrink-0 items-center gap-1.25 px-2.25">
          {[0, 1, 2].map((dot) => (
            <span key={dot} className="size-1.75 rounded-full bg-foreground/15" />
          ))}
        </span>
        <span className="flex flex-col gap-1.5 px-3 pt-1">
          <span className="h-1.5 w-[70%] rounded-full bg-secondary" />
          <span className="h-1.5 w-[48%] rounded-full bg-secondary" />
          <span className="mt-1 h-9 rounded-md bg-secondary/70" />
        </span>
      </div>
      <span className="scene-snap-frame absolute top-4 start-[110px] h-[134px] w-[204px] rounded-[15px] border-[1.5px] border-sky-500 bg-sky-500/6 dark:border-sky-400 dark:bg-sky-400/8" />
      <span
        className={cn(
          "scene-snap-chip absolute end-0 bottom-3 flex items-center gap-1.5 rounded-full border border-border bg-popover py-1 ps-1.5 pe-2.5 text-ui-timestamp font-medium text-foreground",
          DIALOG_HERO_ITEM_SHADOW_CLASS_NAME,
        )}
      >
        <span className="h-3.5 w-4.5 rounded-[3px] bg-linear-to-br from-sky-100 to-sky-300 dark:from-sky-400/40 dark:to-sky-600/60" />
        {t("common:appSnapHeroAddedToChat")}
      </span>
    </div>
  );
}
