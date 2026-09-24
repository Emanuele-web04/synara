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
import { useEffect, useEffectEvent, useState } from "react";

import { isElectron } from "../env";
import { useAppSettings } from "../appSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { CentralIcon } from "../lib/central-icons";
import { cn } from "../lib/utils";
import { AnnouncementSheet } from "./AnnouncementSheet";

const BETA_WELCOME_STORAGE_KEY = "synara:beta-welcome:v1";

const BetaWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type BetaWelcomeStorage = typeof BetaWelcomeStorageSchema.Type;

const INITIAL_STORAGE: BetaWelcomeStorage = { acknowledged: false };

const WELCOME_POINTS = [
  { icon: "shield-check", text: "Synara stays separate and untouched." },
  {
    icon: "heart",
    text: "Beta shares crash reports and anonymous usage stats so we can fix things fast. We don't collect your chats, code, or files.",
  },
  { icon: "arrow-left-circle", text: "Switch back to Synara any time in Settings." },
] as const;

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
  // updateSettingsAndWait is a new function every render; keeping it out of the
  // probe's deps stops the probe (and its settings write) from re-running.
  const markOnboardingCompleted = useEffectEvent(() => {
    void updateSettingsAndWait({ onboardingCompletedAt: new Date().toISOString() }).catch(() => {});
  });

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
            markOnboardingCompleted();
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
  }, [storage.acknowledged, setBetaWelcomePending]);

  const acknowledge = () => {
    setOpen(false);
    setStorage({ acknowledged: true });
    setBetaWelcomePending(false);
  };

  const status =
    imported === true
      ? {
          icon: "circle-check",
          text: "Your chats and settings came over from Synara.",
          className: "bg-[color-mix(in_srgb,var(--beta-accent)_12%,transparent)] text-foreground",
          iconClassName: "text-[var(--beta-accent)]",
        }
      : imported === false
        ? importFailed
          ? {
              icon: "exclamation-circle",
              text: "Your Synara data couldn't be copied, so you're starting fresh.",
              className:
                "bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] text-foreground",
              iconClassName: "text-destructive",
            }
          : {
              icon: "circle-info",
              text: "Starting fresh. Nothing was copied over.",
              className:
                "bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] text-muted-foreground",
              iconClassName: "",
            }
        : null;

  return (
    <AnnouncementSheet
      open={open && !storage.acknowledged}
      hero={
        <div className="relative">
          <div className="absolute -inset-5 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--beta-accent)_45%,transparent),transparent)]" />
          <img src="/app-icons/beta.png" alt="" className="relative size-16 rounded-2xl" />
        </div>
      }
      title="Welcome to Synara Beta"
      description="New features land here first, before they reach Synara."
      details={
        <div className="flex flex-col gap-4 pt-4">
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {WELCOME_POINTS.map((point) => (
              <li key={point.icon} className="flex items-center gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--beta-accent)_14%,transparent)] text-[var(--beta-accent)]">
                  <CentralIcon name={point.icon} className="size-4" />
                </span>
                <span className="text-ui text-foreground">{point.text}</span>
              </li>
            ))}
          </ul>
          {status ? (
            <p
              className={cn(
                "m-0 flex items-center gap-2 rounded-xl px-3 py-2.5 text-ui",
                status.className,
              )}
            >
              <CentralIcon name={status.icon} className={cn("size-4", status.iconClassName)} />
              {status.text}
            </p>
          ) : null}
        </div>
      }
      confirmLabel="Get started"
      onDismiss={acknowledge}
      onConfirm={acknowledge}
    />
  );
}
