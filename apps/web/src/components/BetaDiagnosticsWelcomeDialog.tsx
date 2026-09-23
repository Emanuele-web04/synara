// FILE: BetaDiagnosticsWelcomeDialog.tsx
// Purpose: One-time disclosure that Synara Beta sends always-on diagnostics —
// what is collected, what is not, and where the exact schema lives.
// Layer: Root web overlay
//
// Rendered through the shared AnnouncementSheet; only probes on beta-flavor
// desktop builds (the bridge reports the baked flavor, not an env guess).

import { Schema } from "effect";
import { useEffect, useState } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { AnnouncementSheet } from "./AnnouncementSheet";

const BETA_DIAGNOSTICS_WELCOME_STORAGE_KEY = "synara:beta-diagnostics-welcome:v1";

const BetaDiagnosticsWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type BetaDiagnosticsWelcomeStorage = typeof BetaDiagnosticsWelcomeStorageSchema.Type;

const INITIAL_STORAGE: BetaDiagnosticsWelcomeStorage = { acknowledged: false };

export function BetaDiagnosticsWelcomeDialog() {
  const [storage, setStorage] = useLocalStorage(
    BETA_DIAGNOSTICS_WELCOME_STORAGE_KEY,
    INITIAL_STORAGE,
    BetaDiagnosticsWelcomeStorageSchema,
  );
  const [open, setOpen] = useState(false);
  const onboardingBlocking = useOnboardingDialogStore(
    (store) => !store.startupGateSettled || store.isOpen,
  );

  useEffect(() => {
    if (storage.acknowledged) return;
    const bridge = window.desktopBridge?.beta;
    if (!bridge) return;

    let disposed = false;
    void bridge
      .getState()
      .then((state) => {
        if (!disposed && state.supported && state.flavor === "beta") setOpen(true);
      })
      .catch((error) => {
        // Do not acknowledge a failed probe: a transient startup issue should
        // not permanently hide the disclosure on the next launch.
        console.warn("[beta] Could not check diagnostics disclosure support", error);
      });
    return () => {
      disposed = true;
    };
  }, [storage.acknowledged]);

  const acknowledge = () => {
    setOpen(false);
    setStorage({ acknowledged: true });
  };

  const dialogOpen = open && !storage.acknowledged && !onboardingBlocking;

  return (
    <AnnouncementSheet
      open={dialogOpen}
      hero={
        <img src="/app-icons/beta.png" alt="Synara Beta" className="size-16 shrink-0 rounded-2xl" />
      }
      title="You're on Synara Beta"
      description={
        <>
          Beta always sends crash reports, redacted error messages and log excerpts, and launch and
          update timings — never your chats or files. Full list: docs/diagnostics.md.
        </>
      }
      dismissLabel="Not now"
      confirmLabel="Got it"
      onDismiss={acknowledge}
      onConfirm={acknowledge}
    />
  );
}
