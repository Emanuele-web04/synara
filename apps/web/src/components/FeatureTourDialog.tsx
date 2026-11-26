// FILE: FeatureTourDialog.tsx
// Purpose: Decides when the app tour runs: once per installation after the startup
//          surfaces (first-run onboarding, announcements) have settled, or on a replay from
//          Settings. The tour itself is AppTour.
// Layer: Root web overlay

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AppTour } from "~/featureTour/AppTour";
import {
  EMPTY_FEATURE_TOUR_SEEN,
  FEATURE_TOUR_STORAGE_KEY,
  FeatureTourSeenSchema,
  useFeatureTourStore,
} from "~/featureTour/store";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { useProjectImportAnnouncement } from "~/projectImport/useProjectImportAnnouncement";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";

/** Wait for other dialogs to leave the DOM, including their exit transitions. */
function useOtherDialogOpen(enabled: boolean) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const update = () =>
      setOpen(
        Array.from(
          document.querySelectorAll(
            '[role="dialog"]:not([data-feature-tour]), [role="alertdialog"]',
          ),
        ).some(
          // Base UI toasts also have dialog/alertdialog roles. Waiting for those
          // would delay the slot handoff until their timeout (or manual dismissal).
          (dialog) =>
            !dialog.closest('[data-slot="toast-viewport"], [data-slot="toast-viewport-anchored"]'),
        ),
      );
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role"],
    });
    return () => observer.disconnect();
  }, [enabled]);
  return enabled && open;
}

export function FeatureTourDialog() {
  const installation = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.worktreesDir,
  }).data;
  const [seen, setSeen] = useLocalStorage(
    FEATURE_TOUR_STORAGE_KEY,
    EMPTY_FEATURE_TOUR_SEEN,
    FeatureTourSeenSchema,
  );
  const startupBlocking = useOnboardingDialogStore(
    (state) => !state.startupGateSettled || state.isOpen || state.betaWelcomePending,
  );
  const importing = useProjectImportDialogStore((state) => state.isOpen);
  const importAnnouncement = useProjectImportAnnouncement();
  const owner = useAnnouncementSheetSlotStore((state) => state.owner);
  const handedOff = useAnnouncementSheetSlotStore((state) => state.handedOff);
  const settleStartup = useAnnouncementSheetSlotStore((state) => state.settleStartup);
  const replay = useFeatureTourStore((state) => state.replay);
  const needsTour = Boolean(
    installation && (replay || (!handedOff && !seen.includes(installation))),
  );
  const otherDialog = useOtherDialogOpen(needsTour);
  const [ready, setReady] = useState(false);
  const blocked =
    startupBlocking || importing || (importAnnouncement.visible && !handedOff) || otherDialog;
  // This is the last startup surface, mounted after Safari/AppSnap probes settle.
  // Passive coachmarks wait for the tour to be seen or dismissed before claiming.
  useEffect(() => {
    if (installation && !needsTour && !blocked && !handedOff) settleStartup();
  }, [blocked, handedOff, installation, needsTour, settleStartup]);
  // AppSnap and Safari probes are resolved by the parent before this mounts. The
  // quiet interval lets the announcement queue and dialog exit animation settle.
  useEffect(() => {
    if (blocked || owner !== null || ready || (handedOff && !replay)) return;
    const timer = window.setTimeout(() => setReady(true), 350);
    return () => window.clearTimeout(timer);
  }, [blocked, handedOff, owner, ready, replay]);

  const dismiss = () => {
    if (installation)
      setSeen((current) => (current.includes(installation) ? current : [...current, installation]));
    useFeatureTourStore.getState().close();
  };
  const open = Boolean(
    installation && ready && !blocked && (replay || (!handedOff && !seen.includes(installation))),
  );
  // Replays are deliberate user actions and can run after a startup handoff.
  // They still wait for every currently open dialog.
  return (
    <AppTour key={replay ? "replay" : "startup"} open={open} replay={replay} onDismiss={dismiss} />
  );
}
