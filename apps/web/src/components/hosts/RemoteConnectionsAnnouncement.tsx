// FILE: RemoteConnectionsAnnouncement.tsx
// Purpose: One-time launch for Remote Connections: a sheet, then a hint on the sidebar
//          account button. Without Synara Alto the sheet opens the plans in Usage &
//          limits; with Alto (or where billing is off) it opens Connections.
// Layer: Root web overlay
// Exports: RemoteConnectionsAnnouncement, RemoteConnectionsCoachmark
//
// Both steps share the announcement slot, so they never overlap anything else: the
// sheet is ordered last among startup surfaces, and the hint takes the slot after the
// sheet closes, once its exit animation is done.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import {
  useCallback,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react";

import { useAccount } from "~/hooks/useAccount";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { ACCOUNT_BILLING_ENABLED } from "~/lib/accountBilling";
import { accountBillingQueryOptions } from "~/lib/accountReactQuery";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { AnnouncementSheet } from "../AnnouncementSheet";
import { OneTimeCoachmark } from "../OneTimeCoachmark";
import { useOpenSynaraPlan } from "../settings/BillingSettingsPanel";
import { RemoteConnectionsAnnouncementHero } from "./RemoteConnectionsAnnouncementHero";

export const REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY =
  "synara:remote-connections-announcement:v1";
export const REMOTE_CONNECTIONS_COACHMARK_STORAGE_KEY = "synara:remote-connections-coachmark:v1";

const AnnouncementStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
  // Set only when the sheet itself was closed; the first-run tour skips the hint too.
  pointToAccount: Schema.optional(Schema.Boolean),
});
const INITIAL_STORAGE: typeof AnnouncementStorageSchema.Type = { acknowledged: false };
// Lets the sheet finish closing before the hint appears beside the sidebar.
const COACHMARK_DELAY_MS = 450;

function useAnnouncementStorage() {
  return useLocalStorage(
    REMOTE_CONNECTIONS_ANNOUNCEMENT_STORAGE_KEY,
    INITIAL_STORAGE,
    AnnouncementStorageSchema,
  );
}

function remoteConnectionsAvailable(): boolean {
  // A window that is itself driving another computer has nothing new to learn here.
  const context = readExecutionContext();
  return context?.controller.capabilities.remoteConnections === true && !context.remote;
}

export function RemoteConnectionsAnnouncement() {
  const navigate = useNavigate();
  const openPlans = useOpenSynaraPlan();
  const [storage, setStorage] = useAnnouncementStorage();
  const onboardingOpen = useOnboardingDialogStore((state) => state.isOpen);
  const wantsOpen = remoteConnectionsAvailable() && !storage.acknowledged;

  const { status } = useAccount();
  const billingOptions = accountBillingQueryOptions(status);
  const billing = useQuery({
    ...billingOptions,
    enabled: billingOptions.enabled === true && ACCOUNT_BILLING_ENABLED && wantsOpen,
  });
  const offerPlans = ACCOUNT_BILLING_ENABLED && billing.data?.access !== "granted";

  const close = useCallback(
    () => setStorage({ acknowledged: true, pointToAccount: true }),
    [setStorage],
  );
  // The first-run tour already pairs a device; don't announce the feature afterwards.
  useEffect(() => {
    if (onboardingOpen && wantsOpen) setStorage({ acknowledged: true });
  }, [onboardingOpen, setStorage, wantsOpen]);

  return (
    <AnnouncementSheet
      open={wantsOpen}
      order="last"
      presentation="feature"
      hero={<RemoteConnectionsAnnouncementHero />}
      title="Introducing Remote Connections"
      description={
        offerPlans
          ? "Control Synara on one computer from another. Included with Synara Alto; iPhone and iPad are coming soon."
          : "Control Synara on one computer from another. Pair a device to start; iPhone and iPad are coming soon."
      }
      dismissLabel="Not now"
      confirmLabel={offerPlans ? "View Alto plans" : "Connect a device"}
      onDismiss={close}
      onConfirm={() => {
        close();
        if (offerPlans) openPlans();
        else void navigate({ to: "/settings", search: { section: "connections" } });
      }}
    />
  );
}

/**
 * Wraps the sidebar account button: once the launch sheet closes, points at it with
 * the next step (sign in, or open Connections) for a few seconds, then never again.
 */
export function RemoteConnectionsCoachmark({
  signedIn,
  tooltip,
  children,
}: {
  signedIn: boolean;
  tooltip: string;
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  const [storage] = useAnnouncementStorage();
  const follows = remoteConnectionsAvailable() && storage.pointToAccount === true;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!follows) return;
    const timeout = window.setTimeout(() => setReady(true), COACHMARK_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [follows]);

  return (
    <OneTimeCoachmark
      storageKey={REMOTE_CONNECTIONS_COACHMARK_STORAGE_KEY}
      title={signedIn ? "Your computers live here" : "Sign in to connect"}
      description={
        signedIn
          ? "Open your account and choose Connections to pair another computer."
          : "Sign in here, then pair your other computer from Connections."
      }
      tooltip={tooltip}
      ready={follows && ready}
      allowAfterHandOff
    >
      {children}
    </OneTimeCoachmark>
  );
}
