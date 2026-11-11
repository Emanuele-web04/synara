// FILE: BillingSettingsPanel.tsx
// Purpose: The "Synara Alto" section of Usage & limits — two plan cards (monthly,
//          annual) that each open their checkout, or the current plan with Manage.
//          Checkout and the customer portal open in the browser through Polar, using
//          the server-selected billing environment.
// Layer: Web settings feature

import type { AccountBillingStatus, AccountStatus } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "~/hooks/useAccount";
import { getFormatLocale, t } from "~/i18n";
import { accountBillingQueryOptions } from "~/lib/accountReactQuery";
import {
  formatBillingPrice,
  isPolarBillingUrl,
  runAccountBillingOperation,
} from "~/lib/accountBilling";
import { accountErrorMessage, readAccountErrorCode } from "~/lib/accountLogic";
import { accountStatusScope } from "~/lib/hosts/controlQueryScope";
import { trackReliabilityIssue } from "~/lib/productAnalytics";
import { ensureNativeApi } from "~/nativeApi";
import { useAccountDialogStore } from "../account/accountDialogStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { SETTINGS_CARD_CLASS_NAME } from "~/settingsPanelStyles";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { SettingsCard, SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

/** Deep-link target for "See plans" / plan links elsewhere in Settings. */
export const SYNARA_PLAN_SECTION_ID = "settings-synara-plan";

/** Opens the plan section of Usage & limits. */
export function useOpenSynaraPlan() {
  const navigate = useNavigate();
  return () =>
    void navigate({
      to: "/settings",
      search: { section: "usage", target: SYNARA_PLAN_SECTION_ID },
    });
}

/**
 * The profile's only nod to billing: a quiet "Free plan" / "Alto" link to the plan
 * in Usage & limits. Hidden until the plan is known, so it never flashes a guess.
 */
export function SynaraPlanLink() {
  const { status } = useAccount();
  const query = useQuery(accountBillingQueryOptions(status));
  const openPlan = useOpenSynaraPlan();
  if (status?.state !== "signed-in" || !query.data?.available) return null;
  return (
    <Button variant="ghost" size="sm" onClick={openPlan}>
      {query.data.access === "granted" ? t("settings:altoProPlan") : "Free plan"}
    </Button>
  );
}

export function BillingSettingsPanel() {
  const { status } = useAccount();
  const scope = accountStatusScope(status ?? { state: "signed-out" });
  return <BillingAccountPanel key={scope} status={status} scope={scope} />;
}

function BillingAccountPanel({ status, scope }: { status: AccountStatus | null; scope: string }) {
  const queryClient = useQueryClient();
  const query = useQuery(accountBillingQueryOptions(status));
  const [pending, setPending] = useState(false);
  // `opened` asks the user to refresh once they are back from the browser.
  const [message, setMessage] = useState<{ text: string; opened: boolean } | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const signedIn = status?.state === "signed-in";
  const billing = query.data;
  const sandbox = billing?.environment === "sandbox";

  const openBilling = async (interval?: "month" | "year") => {
    if (pending || !signedIn || !billing?.available) return;
    setPending(true);
    setMessage(null);
    try {
      const redirect = await runAccountBillingOperation(scope, (account) =>
        interval ? account.billingCheckout({ interval }) : account.billingPortal(),
      );
      if (!mounted.current) return;
      if (
        redirect.environment !== billing.environment ||
        !isPolarBillingUrl(redirect.url, billing.environment)
      ) {
        throw new Error("The billing link could not be verified.");
      }
      await ensureNativeApi().shell.openExternal(redirect.url);
      if (mounted.current) {
        setMessage({
          text: sandbox
            ? "Test billing opened in your browser."
            : "Billing opened in your browser.",
          opened: true,
        });
      }
    } catch (cause) {
      trackReliabilityIssue("billing.redirect_failed");
      if (mounted.current) {
        const fallback = sandbox
          ? t("settings:testBillingOpenFailed")
          : t("settings:billingOpenFailed");
        setMessage({
          text: readAccountErrorCode(cause) ? accountErrorMessage(cause, fallback) : fallback,
          opened: false,
        });
      }
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
    <SettingsSectionShell
      id={SYNARA_PLAN_SECTION_ID}
      title="settings:synaraAltoPro"
      action={sandbox ? <Badge variant="outline">Sandbox</Badge> : undefined}
    >
      {!signedIn ? (
        <SettingsCard>
          <SettingsListRow
            title="Sign in to subscribe"
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
        </SettingsCard>
      ) : query.isPending ? (
        <SettingsCard>
          <SettingsListRow title="Loading plans…" />
        </SettingsCard>
      ) : query.isError ? (
        <SettingsCard>
          <SettingsListRow
            title="Couldn’t load plans"
            actions={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        </SettingsCard>
      ) : !billing?.available ? (
        <SettingsCard>
          <SettingsListRow
            title={sandbox ? "Test billing is not configured" : "Billing is not configured"}
          />
        </SettingsCard>
      ) : (
        <>
          {billing.canCheckout ? (
            // Each card opens its own checkout.
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {billing.plans.map((plan) => (
                <PlanCard
                  key={plan.interval}
                  plan={plan}
                  disabled={pending}
                  onChoose={() => void openBilling(plan.interval)}
                />
              ))}
            </div>
          ) : (
            // Subscribers, and anyone with no plan on offer right now: never an
            // empty section.
            <SettingsCard>
              <SettingsListRow
                title={planTitle(billing)}
                actions={
                  billing.canManage ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => void openBilling()}
                    >
                      Manage
                    </Button>
                  ) : null
                }
              />
            </SettingsCard>
          )}
          {billing.canCheckout && billing.canManage ? (
            // A former subscriber keeps the portal for invoices and payment details.
            <button
              type="button"
              className="self-start text-ui-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-64"
              disabled={pending}
              onClick={() => void openBilling()}
            >
              Manage billing
            </button>
          ) : null}
        </>
      )}
      {message ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          {message.text}
          {message.opened ? (
            <>
              {" "}
              <button
                type="button"
                className="text-foreground underline-offset-2 hover:underline disabled:opacity-64"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Refresh
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </SettingsSectionShell>
  );
}

/** One plan, one click: the card opens that interval's checkout. */
function PlanCard(props: {
  plan: AccountBillingStatus["plans"][number];
  disabled: boolean;
  onChoose: () => void;
}) {
  const monthly = props.plan.interval === "month";
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onChoose}
      className={cn(
        SETTINGS_CARD_CLASS_NAME,
        ELEVATED_HOVER_SURFACE_CLASS_NAME,
        "flex flex-col items-start gap-1 px-4 py-3.5 text-left disabled:pointer-events-none disabled:opacity-64",
      )}
    >
      <span className="text-ui text-muted-foreground">{monthly ? "Monthly" : "Annual"}</span>
      <span className="text-ui-lg font-semibold text-foreground">
        {formatBillingPrice(props.plan)}
        <span className="font-normal text-muted-foreground"> / {monthly ? "month" : "year"}</span>
      </span>
    </button>
  );
}

function planTitle(status: AccountBillingStatus): string {
  if (status.access !== "granted") return "Free";
  if (status.cancelAtPeriodEnd && status.validUntil) {
    return t("settings:altoProPlanEnds", {
      date: new Date(status.validUntil).toLocaleDateString(getFormatLocale()),
    });
  }
  return t("settings:altoProPlan");
}
