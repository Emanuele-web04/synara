// FILE: BetaWelcomeDialog.tsx
// Purpose: First-launch welcome on Synara Beta — what beta is, that stable stays
//          untouched, the diagnostics disclosure, and the stable→beta import
//          result. The first-run tour waits for this sheet and is skipped when
//          data was imported.
// Layer: Root web overlay
//
// Rendered through the shared AnnouncementSheet; only probes on beta-flavor
// desktop builds (the bridge reports the baked flavor, not an env guess).

import { Schema } from "effect";
import { useEffect, useState } from "react";

import { isElectron } from "../env";
import { useAppSettings } from "../appSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { AnnouncementSheet } from "./AnnouncementSheet";

const BETA_WELCOME_STORAGE_KEY = "synara:beta-welcome:v1";

const BetaWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type BetaWelcomeStorage = typeof BetaWelcomeStorageSchema.Type;

const INITIAL_STORAGE: BetaWelcomeStorage = { acknowledged: false };

export function BetaWelcomeDialog() {
  const [storage, setStorage] = useLocalStorage(
    BETA_WELCOME_STORAGE_KEY,
    INITIAL_STORAGE,
    BetaWelcomeStorageSchema,
  );
  const [open, setOpen] = useState(false);
  const [imported, setImported] = useState<boolean | null>(null);
  const [importFailed, setImportFailed] = useState(false);
  const { updateSettingsAndWait } = useAppSettings();
  const setBetaWelcomePending = useOnboardingDialogStore((store) => store.setBetaWelcomePending);

  useEffect(() => {
    if (storage.acknowledged) return;
    const bridge = window.desktopBridge?.beta;
    if (!isElectron || !bridge) return;

    // Hold the first-run tour until the probe answers and the sheet is seen.
    setBetaWelcomePending(true);
    let disposed = false;
    void bridge
      .getState()
      .then((state) => {
        if (disposed) return;
        if (state.supported && state.flavor === "beta") {
          const didImport = state.lastImportAt !== null;
          setImported(didImport);
          setImportFailed(state.lastImportError !== null);
          if (didImport) {
            // Imported installs are already set up; the normal tour never runs.
            void updateSettingsAndWait({
              onboardingCompletedAt: new Date().toISOString(),
            }).catch(() => {});
          }
          setOpen(true);
        } else {
          setBetaWelcomePending(false);
        }
      })
      .catch((error) => {
        // Do not acknowledge a failed probe: a transient startup issue should
        // not permanently hide the welcome on the next launch.
        console.warn("[beta] Could not check beta welcome support", error);
        setBetaWelcomePending(false);
      });
    return () => {
      disposed = true;
      setBetaWelcomePending(false);
    };
  }, [storage.acknowledged, setBetaWelcomePending, updateSettingsAndWait]);

  const acknowledge = () => {
    setOpen(false);
    setStorage({ acknowledged: true });
    setBetaWelcomePending(false);
  };

  return (
    <AnnouncementSheet
      open={open && !storage.acknowledged}
      hero={
        <img src="/app-icons/beta.png" alt="Synara Beta" className="size-16 shrink-0 rounded-2xl" />
      }
      title="Welcome to Synara Beta"
      description={
        <>
          New features land here first.
          <br />
          Your Synara app stays separate and untouched.
          <br />
          Crash and error reports are on, with private info removed.
          {imported === true ? (
            <>
              <br />
              <span className="text-foreground">
                Your chats and settings came over from Synara.
              </span>
            </>
          ) : imported === false ? (
            <>
              <br />
              <span className="text-foreground">
                {importFailed
                  ? "Your Synara data could not be copied, so you're starting fresh."
                  : "Starting fresh — nothing was copied over."}
              </span>
            </>
          ) : null}
        </>
      }
      confirmLabel="Get started"
      onDismiss={acknowledge}
      onConfirm={acknowledge}
    />
  );
}
