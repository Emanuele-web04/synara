import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { productAnalyticsBridge } from "~/lib/productAnalytics";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { IS_REMOTE_DESKTOP } from "~/branding";

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
  const title = IS_REMOTE_DESKTOP ? "Share usage and diagnostics" : "Share product analytics";
  return (
    <SettingsSection title="Privacy">
      <SettingsRow
        title={title}
        description={
          IS_REMOTE_DESKTOP
            ? "Helps us fix bugs and count active users: feature use, connection and turn outcomes, errors and crashes, sent to our Cloudflare service. Never your chats, prompts, files or account details. On by default in Synara Remote; applies only to this installation."
            : "Help improve Synara with feature counts, connection outcomes and performance sent to our Cloudflare service. No chat content, files or account details. Off by default; applies only to this installation."
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
              Retry loading privacy settings
            </Button>
          ) : change.isError ? (
            "Could not save your choice. Your previous setting is still shown; try again."
          ) : IS_REMOTE_DESKTOP ? (
            "Turning this off stops collection and clears unsent events."
          ) : (
            "Turning this off clears unsent product events. Beta crash diagnostics are separate."
          )
        }
      />
    </SettingsSection>
  );
}
