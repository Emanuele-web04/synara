// FILE: RemoteConnectionsAnnouncement.tsx
// Purpose: One-time launch for Remote Connections: a sheet, then a hint on the sidebar
//          account button. Without Synara Alto the sheet opens the plans in Usage &
//          limits; with Alto (or where billing is off) it opens Connections.
// Layer: Root web overlay
// Exports: RemoteConnectionsAnnouncement, RemoteConnectionsCoachmark
//
// Nothing here may overlap another surface:
// - Both steps share the announcement slot. The sheet is ordered last among startup
//   surfaces; the hint takes the slot only after the sheet has finished closing.
// - The team sharing consent (HostDiscoverabilityPrompt) opens outside that slot, so
//   both steps also wait for the account and host enrollment to load and stand aside
//   while that consent is owed.
// - The hint follows only "Not now" / close. The call to action already lands on a
//   page with its own next step (Sign in, Connect a device), where a hint on the
//   sidebar would cover Settings and could sit over the sign-in dialog.

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactElement } from "react";

import { useAccount } from "~/hooks/useAccount";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { ACCOUNT_BILLING_ENABLED } from "~/lib/accountBillingFlag";
import { accountBillingQueryOptions } from "~/lib/accountReactQuery";
import { shouldPromptForDiscoverability } from "~/lib/hosts/enrollment";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { remoteHostEnrollmentQueryOptions } from "~/lib/hosts/queries";
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
  // Set only when the sheet was dismissed; its call to action and the first-run tour
  // already lead somewhere, so they skip the hint.
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

function useRemoteConnectionsAvailable(): boolean {
  const inRemoteWorkspace = useRouterState({
    select: (state) => state.location.pathname === "/remote",
  });
  const context = readExecutionContext();
  return (
    context?.controller.capabilities.remoteConnections === true &&
    !context.remote &&
    !inRemoteWorkspace
  );
}

/**
 * True once nothing outside the announcement slot can still claim the screen: the
 * account has loaded and, when signed in, no team sharing consent is owed.
 */
function useClearOfOutsideDialogs(wanted: boolean): boolean {
  const account = useAccount();
  const signedIn = account.status?.state === "signed-in";
  const enrollment = useQuery({
    ...remoteHostEnrollmentQueryOptions({ enabled: wanted && signedIn }),
    select: (data) => shouldPromptForDiscoverability(data).prompt,
  });
  if (!wanted || account.statusQuery.isPending) return false;
  if (!signedIn) return true;
  // The consent dialog uses cached enrollment even when a refetch fails.
  return enrollment.data === undefined ? enrollment.isError : !enrollment.data;
}

export function RemoteConnectionsAnnouncement() {
  const navigate = useNavigate();
  const openPlans = useOpenSynaraPlan();
  const [storage, setStorage] = useAnnouncementStorage();
  const onboardingOpen = useOnboardingDialogStore((state) => state.isOpen);
  const available = useRemoteConnectionsAvailable();
  const unseen = available && !storage.acknowledged;
  const clear = useClearOfOutsideDialogs(unseen);

  const { status, statusQuery } = useAccount();
  const billingOptions = accountBillingQueryOptions(status);
  const billing = useQuery({
    ...billingOptions,
    enabled: billingOptions.enabled === true && ACCOUNT_BILLING_ENABLED && unseen,
  });
  const checkingAccess =
    ACCOUNT_BILLING_ENABLED &&
    (statusQuery.isPending || (billingOptions.enabled === true && billing.isPending));
  const offerPlans =
    ACCOUNT_BILLING_ENABLED && (status?.state === "signed-out" || billing.data?.access === "none");

  // The first-run tour already pairs a device; don't announce the feature afterwards.
  useEffect(() => {
    if (onboardingOpen && unseen) setStorage({ acknowledged: true });
  }, [onboardingOpen, setStorage, unseen]);

  return (
    <AnnouncementSheet
      open={unseen && clear && !checkingAccess}
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
      onDismiss={() => setStorage({ acknowledged: true, pointToAccount: true })}
      onConfirm={() => {
        setStorage({ acknowledged: true });
        if (offerPlans) openPlans();
        else void navigate({ to: "/settings", search: { section: "connections" } });
      }}
    />
  );
}

/**
 * Wraps the sidebar account button: after the launch sheet is dismissed, points at it
 * with the next step (sign in, or open Connections) for a few seconds, then never again.
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
  const available = useRemoteConnectionsAvailable();
  const follows = available && storage.pointToAccount === true;
  const clear = useClearOfOutsideDialogs(follows);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!follows) return;
    const timeout = window.setTimeout(() => setSettled(true), COACHMARK_DELAY_MS);
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
      ready={follows && settled && clear}
    >
      {children}
    </OneTimeCoachmark>
  );
}
