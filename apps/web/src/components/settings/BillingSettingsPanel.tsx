// Sandbox subscription controls reuse the profile Settings surface. No feature gate lives here.
import type { AccountBillingStatus, AccountStatus } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "~/hooks/useAccount";
import { accountBillingQueryOptions } from "~/lib/accountReactQuery";
import {
  formatBillingPrice,
  isPolarSandboxUrl,
  runAccountBillingOperation,
} from "~/lib/accountBilling";
import { accountStatusScope } from "~/lib/hosts/controlQueryScope";
import { ensureNativeApi } from "~/nativeApi";
import { useAccountDialogStore } from "../account/accountDialogStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsCard, SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

export function BillingSettingsPanel() {
  const { status } = useAccount();
  const scope = accountStatusScope(status ?? { state: "signed-out" });
  return <BillingAccountPanel key={scope} status={status} scope={scope} />;
}

function BillingAccountPanel({ status, scope }: { status: AccountStatus | null; scope: string }) {
  const queryClient = useQueryClient();
  const query = useQuery(accountBillingQueryOptions(status));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const signedIn = status?.state === "signed-in";
  const billing = query.data;

  const openBilling = async (interval?: "month" | "year") => {
    if (pending || !signedIn) return;
    setPending(true);
    setMessage(null);
    try {
      const redirect = await runAccountBillingOperation(scope, (account) =>
        interval ? account.billingCheckout({ interval }) : account.billingPortal(),
      );
      if (!mounted.current) return;
      if (redirect.environment !== "sandbox" || !isPolarSandboxUrl(redirect.url)) {
        throw new Error("The test billing link could not be verified.");
      }
      await ensureNativeApi().shell.openExternal(redirect.url);
      if (mounted.current)
        setMessage("Test billing opened in your browser. Refresh after finishing.");
    } catch {
      if (mounted.current) setMessage("Could not open test billing. Try again.");
    } finally {
      if (mounted.current) {
        setPending(false);
        void queryClient.invalidateQueries({
          queryKey: accountBillingQueryOptions(status).queryKey,
        });
      }
    }
  };

  return (
    <SettingsSectionShell title="Subscription" action={<Badge variant="outline">Sandbox</Badge>}>
      <SettingsCard>
        {!signedIn ? (
          <SettingsListRow
            title="Test a desktop subscription"
            description="Sign in to use the Polar sandbox. No real payments are taken."
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={!status}
                onClick={() => useAccountDialogStore.getState().openSignIn()}
              >
                Sign in
              </Button>
            }
          />
        ) : query.isPending ? (
          <SettingsListRow
            title="Loading subscription…"
            description="Checking this account’s sandbox subscription."
          />
        ) : query.isError ? (
          <SettingsListRow
            title="Subscription unavailable"
            description="Couldn’t check test billing. Your current app access is unchanged."
            actions={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        ) : !billing?.available ? (
          <SettingsListRow
            title="Test billing is not configured"
            description="Your current app access is unchanged. iPhone and iPad remain free companions."
          />
        ) : (
          <>
            <SettingsListRow
              title={
                billing.access === "granted" ? "Test subscription access" : "Desktop subscription"
              }
              description={subscriptionDescription(billing)}
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={query.isFetching || pending}
                  onClick={() => void query.refetch()}
                >
                  Refresh
                </Button>
              }
            />
            {billing.canCheckout
              ? billing.plans.map((plan) => (
                  <SettingsListRow
                    key={plan.interval}
                    title={plan.interval === "month" ? "Monthly" : "Annual"}
                    description={`${formatBillingPrice(plan)} / ${plan.interval === "month" ? "month" : "year"}`}
                    actions={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => void openBilling(plan.interval)}
                      >
                        Test checkout
                      </Button>
                    }
                  />
                ))
              : null}
            {billing.canManage ? (
              <SettingsListRow
                title="Manage test subscription"
                description="Update or cancel in Polar’s sandbox customer portal."
                actions={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void openBilling()}
                  >
                    Manage
                  </Button>
                }
              />
            ) : null}
          </>
        )}
      </SettingsCard>
      {billing?.available ? (
        <p className="text-ui-sm text-muted-foreground">
          Sandbox only. No real payments. iPhone and iPad remain free companions; test subscriptions
          do not change your app access.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </SettingsSectionShell>
  );
}

function subscriptionDescription(status: AccountBillingStatus): string {
  if (status.cancelAtPeriodEnd && status.validUntil) {
    return `Ends ${new Date(status.validUntil).toLocaleDateString()}. No real payments are taken.`;
  }
  return status.access === "granted"
    ? "Access confirmed in Polar sandbox. Your current app access is unchanged."
    : "Try monthly or annual billing with test payment details. No real payments are taken.";
}
