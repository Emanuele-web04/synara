import { t, useTranslation } from "~/i18n";
// Subscription controls reuse profile Settings and the server-selected billing environment.
import type { AccountBillingStatus, AccountStatus } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "~/hooks/useAccount";
import { accountBillingQueryOptions } from "~/lib/accountReactQuery";
import {
  formatBillingPrice,
  isPolarBillingUrl,
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
  const { t, formatLocale } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery(accountBillingQueryOptions(status));
  const [pending, setPending] = useState(false);
  // Keep display state semantic so an open billing result follows language changes.
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
        setMessage(
          sandbox ? "settings:remote_billing_testOpened" : "settings:remote_billing_opened",
        );
      }
    } catch {
      if (mounted.current) {
        setMessage(
          sandbox ? "settings:remote_billing_testOpenFailed" : "settings:remote_billing_openFailed",
        );
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
      title={t("settings:remote_billing_subscription")}
      action={
        billing ? (
          <Badge variant="outline">
            {sandbox
              ? t("settings:remote_billing_sandbox")
              : t("settings:remote_billing_production")}
          </Badge>
        ) : undefined
      }
    >
      <SettingsCard>
        {!signedIn ? (
          <SettingsListRow
            title={t("settings:remote_billing_proTitle")}
            description={t("settings:remote_billing_localFree")}
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={!status}
                onClick={() => useAccountDialogStore.getState().openSignIn()}
              >
                {t("chat:providerModelPicker_signIn")}
              </Button>
            }
          />
        ) : query.isPending ? (
          <SettingsListRow
            title={t("settings:remote_billing_loading")}
            description={t("settings:remote_billing_checking")}
          />
        ) : query.isError ? (
          <SettingsListRow
            title={t("settings:remote_billing_unavailable")}
            description={t("settings:remote_billing_checkFailed")}
            actions={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t("chat:profile_tryAgain")}
              </Button>
            }
          />
        ) : !billing?.available ? (
          <SettingsListRow
            title={
              sandbox
                ? t("settings:remote_billing_testNotConfigured")
                : t("settings:remote_billing_notConfigured")
            }
            description={t("settings:remote_billing_accessUnchanged")}
          />
        ) : (
          <>
            <SettingsListRow
              title={
                sandbox
                  ? t("settings:remote_billing_testPro")
                  : t("settings:remote_billing_proTitle")
              }
              description={subscriptionDescription(billing, t, formatLocale)}
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={query.isFetching || pending}
                  onClick={() => void query.refetch()}
                >
                  {t("chat:list_refreshAriaLabel")}
                </Button>
              }
            />
            {billing.canCheckout
              ? billing.plans.map((plan) => (
                  <SettingsListRow
                    key={plan.interval}
                    title={
                      plan.interval === "month"
                        ? t("settings:remote_billing_monthly")
                        : t("settings:remote_billing_annual")
                    }
                    description={`${formatBillingPrice(plan)} / ${plan.interval === "month" ? t("settings:remote_billing_month") : t("settings:remote_billing_year")}`}
                    actions={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => void openBilling(plan.interval)}
                      >
                        {sandbox
                          ? t("settings:remote_billing_testCheckout")
                          : t("settings:remote_billing_checkout")}
                      </Button>
                    }
                  />
                ))
              : null}
            {billing.canManage ? (
              <SettingsListRow
                title={
                  sandbox
                    ? t("settings:remote_billing_manageTestSubscription")
                    : t("settings:remote_billing_manageSubscription")
                }
                description={
                  sandbox
                    ? t("settings:remote_billing_testPortalDescription")
                    : t("settings:remote_billing_portalDescription")
                }
                actions={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void openBilling()}
                  >
                    {t("settings:remote_billing_manage")}
                  </Button>
                }
              />
            ) : null}
          </>
        )}
      </SettingsCard>
      {billing?.available ? (
        <p className="text-ui-sm text-muted-foreground">
          {sandbox
            ? t("settings:remote_billing_sandboxNotice")
            : t("settings:remote_billing_paymentsNotice")}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          {t(message)}
        </p>
      ) : null}
    </SettingsSectionShell>
  );
}

function subscriptionDescription(
  status: AccountBillingStatus,
  translate: typeof t,
  formatLocale: string,
): string {
  const sandbox = status.environment === "sandbox";
  if (status.cancelAtPeriodEnd && status.validUntil) {
    return translate(
      sandbox ? "settings:remote_billing_testEnds" : "settings:remote_billing_ends",
      {
        date: new Date(status.validUntil).toLocaleDateString(formatLocale),
      },
    );
  }
  if (status.access === "granted") {
    return sandbox
      ? translate("settings:remote_billing_testAccessConfirmed")
      : translate("settings:remote_billing_localFree");
  }
  return sandbox
    ? translate("settings:remote_billing_testPlansDescription")
    : translate("settings:remote_billing_localFree");
}
