import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { productAnalyticsBridge } from "~/lib/productAnalytics";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";

const queryKey = ["desktop", "product-analytics-consent"] as const;

export function ProductAnalyticsSettingsPanel() {
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
  return (
    <SettingsSection title="Privacy">
      <SettingsRow
        title="Share product analytics"
        description="Help improve Synara with feature counts, connection outcomes and performance sent to our Cloudflare service. No chat content, files or account details. Off by default; applies only to this installation."
        control={
          <Switch
            aria-label="Share product analytics"
            checked={state.data?.enabled ?? false}
            disabled={state.isPending || state.isError || change.isPending}
            onCheckedChange={(checked) => change.mutate(Boolean(checked))}
          />
        }
        status={
          state.isError ? (
            <Button variant="outline" size="sm" onClick={() => void state.refetch()}>
              Retry loading privacy settings
            </Button>
          ) : change.isError ? (
            "Could not save your choice. Your previous setting is still shown; try again."
          ) : (
            "Turning this off clears unsent product events. Beta crash diagnostics are separate."
          )
        }
      />
    </SettingsSection>
  );
}
