// Purpose: Shows this installation's product analytics choice through the desktop bridge.
// Remote also uses this choice for its separate diagnostics sender.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { productAnalyticsBridge } from "~/lib/productAnalytics";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { IS_REMOTE_DESKTOP } from "~/branding";
import { useTranslation } from "~/i18n";

const queryKey = ["desktop", "product-analytics-consent"] as const;

// Keep the persisted choice visible while reads or writes fail.
export function ProductAnalyticsSettingsPanel() {
  const { t } = useTranslation();
  const bridge = productAnalyticsBridge();
  const client = useQueryClient();
  const state = useQuery({
    queryKey,
    queryFn: () => bridge!.getState(),
    enabled: !!bridge,
    retry: false,
  });
  const change = useMutation({
    mutationFn: (enabled: boolean) => bridge!.setEnabled(enabled),
    onSuccess: (value) => client.setQueryData(queryKey, value),
  });
  if (!bridge) return null;
  const title = IS_REMOTE_DESKTOP
    ? t("settings:productAnalyticsRemoteShareTitle")
    : t("settings:productAnalyticsShareTitle");
  return (
    <SettingsSection title="settings:productAnalyticsPrivacyTitle">
      <SettingsRow
        title={title}
        description={
          IS_REMOTE_DESKTOP
            ? t("settings:productAnalyticsRemoteDescription")
            : t("settings:productAnalyticsDescription")
        }
        control={
          <Switch
            aria-label={title}
            checked={state.data?.enabled ?? false}
            disabled={state.isPending || state.isError || change.isPending}
            onCheckedChange={(checked) => change.mutate(Boolean(checked))}
          />
        }
        status={
          state.isError ? (
            <Button variant="outline" size="sm" onClick={() => void state.refetch()}>
              {t("settings:productAnalyticsRetryLoad")}
            </Button>
          ) : change.isError ? (
            t("settings:productAnalyticsSaveError")
          ) : IS_REMOTE_DESKTOP ? (
            t("settings:productAnalyticsRemoteDisableDescription")
          ) : (
            t("settings:productAnalyticsDisableDescription")
          )
        }
      />
    </SettingsSection>
  );
}
