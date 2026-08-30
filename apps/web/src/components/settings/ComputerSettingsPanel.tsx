// FILE: ComputerSettingsPanel.tsx
// Purpose: Own the Computer use settings panel: desktop backend status and computer-control preferences.
// Layer: Settings UI components
// Exports: ComputerSettingsPanel

import {
  COMPUTER_RELEASE_CONTROL_HOTKEY,
  COMPUTER_RELEASE_HOTKEY_BACKENDS,
  type ComputerCapabilities,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AppSettingsBinding } from "~/appSettings";
import { resolveComputerAvailabilityView } from "~/components/ComputerPanel.logic";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import {
  COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
  computerStatusQueryOptions,
  provisionComputer,
  serverQueryKeys,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { SettingResetButton } from "./SettingControls";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionShell,
  SettingsSection,
} from "./SettingsPanelPrimitives";

const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  kwin: "KWin plugin (KDE)",
  hyprland: "Hyprland plugin",
  "nested-kwin": "Isolated agent desktop (nested KWin)",
  fake: "Test backend",
};

/** Ordered to read as a sentence of abilities, most consequential first. */
const CAPABILITY_LABELS: ReadonlyArray<{
  readonly key: keyof ComputerCapabilities;
  readonly label: string;
}> = [
  { key: "capture", label: "screen capture" },
  { key: "input", label: "input" },
  { key: "windows", label: "window listing" },
  { key: "windowBounds", label: "window geometry" },
  { key: "stacking", label: "stacking order" },
  { key: "activation", label: "window activation" },
  { key: "clipboard", label: "clipboard" },
  { key: "ghostCursor", label: "ghost cursor" },
];

function capabilitySummary(capabilities: ComputerCapabilities): string {
  const enabled = CAPABILITY_LABELS.filter((entry) => capabilities[entry.key]).map(
    (entry) => entry.label,
  );
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

export function ComputerSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
  const statusQuery = useQuery({
    ...computerStatusQueryOptions(),
    enabled: active,
    // Health can flip (reconnecting, recovered) while the panel is open.
    refetchInterval: active ? COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS : false,
  });

  const queryClient = useQueryClient();
  const setupMutation = useMutation({
    mutationFn: provisionComputer,
    onSuccess: (result) => {
      // The call already returns the refreshed status, so the card repaints
      // from the same round trip rather than racing a refetch against a
      // backend that has only just rebuilt its providers.
      queryClient.setQueryData(serverQueryKeys.computerStatus(), result.status);
    },
  });

  if (!active) return null;

  const status = statusQuery.data;
  const availabilityView = statusQuery.isError
    ? {
        kind: "blocked" as const,
        title: "Computer status is unavailable",
        description:
          statusQuery.error instanceof Error && statusQuery.error.message
            ? statusQuery.error.message
            : "The server could not be reached.",
      }
    : resolveComputerAvailabilityView(status?.availability, status?.health);
  const backend =
    status?.availability.kind === "available" ? (status.availability.backend ?? null) : null;
  const health = status?.health;
  // The emergency release is a shortcut the compositor plugin (KWin or
  // Hyprland) registers with the compositor. No other backend binds it, and a
  // nested offscreen session never hears the human's keys, so only a visible
  // plugin-backed desktop may promise it.
  const dedicatedSeatDescription =
    backend !== null &&
    COMPUTER_RELEASE_HOTKEY_BACKENDS.includes(backend) &&
    status?.capabilities.visibleDesktop === true
      ? `The agent drives its own seat, so your cursor and focus stay untouched. Press ${COMPUTER_RELEASE_CONTROL_HOTKEY} at any time to stop it from acting on the desktop, and press it again to let it resume.`
      : "The agent drives its own seat, so your cursor and focus stay untouched.";
  const setupNote = setupMutation.isPending
    ? "Setting up the agent's desktop. This may open your system's authorization dialog to install packages, and can take a few minutes if the plugin compiles from source."
    : setupMutation.isError
      ? `Setting up failed. ${
          setupMutation.error instanceof Error && setupMutation.error.message
            ? setupMutation.error.message
            : "The server gave no reason."
        }`
      : setupMutation.isSuccess
        ? setupMutation.data.summary
        : undefined;
  /**
   * Whether this desktop still needs something installed.
   *
   * Offered when the backend has something to install and is not connected.
   * Neither the availability kind nor the capabilities can carry this: on a
   * machine that has never provisioned, the passive probe answers "available"
   * as long as a helper *could* be built, and a backend that installs its own
   * helper advertises the full capability set before the helper exists, while
   * the unsupported backend advertises none and has nothing to set up.
   */
  const needsSetup =
    status !== undefined && status.provisionable && status.health.status !== "connected";
  const healthNotes = [
    ...(health && health.reconnects > 0
      ? [
          `Reconnected ${health.reconnects === 1 ? "once" : `${health.reconnects} times`} since startup.`,
        ]
      : []),
    ...(health?.lastFailure && availabilityView.kind === "ready"
      ? [`Last failure: ${health.lastFailure.message}`]
      : []),
  ];

  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title="Desktop backend"
        action={
          <div className="flex items-center gap-2">
            {/* Offered whenever the desktop is not ready. Setting up installs
                whatever this backend still needs — distribution packages
                through the system's own authorization dialog, Synara's KWin
                plugin into the user's home — and boots the agent's desktop. */}
            {needsSetup && !statusQuery.isError ? (
              <Button
                size="xs"
                variant="default"
                disabled={setupMutation.isPending}
                onClick={() => setupMutation.mutate()}
              >
                {setupMutation.isPending ? "Setting up…" : "Set up"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={statusQuery.isFetching || setupMutation.isPending}
              onClick={() => void statusQuery.refetch()}
            >
              {statusQuery.isFetching ? "Checking…" : "Refresh"}
            </Button>
          </div>
        }
      >
        <SettingsCard>
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    availabilityView.kind === "ready"
                      ? "bg-emerald-500"
                      : availabilityView.kind === "checking"
                        ? "animate-pulse bg-amber-500"
                        : "bg-red-500",
                  )}
                />
                {availabilityView.title}
              </span>
            }
            description={availabilityView.description}
            status={[setupNote, ...healthNotes].filter(Boolean).join(" ") || undefined}
          />
          {backend ? (
            <SettingsRow
              title="Backend"
              description="Which desktop integration serves perception and input."
              control={
                <span className="text-sm text-muted-foreground">
                  {BACKEND_DISPLAY_NAMES[backend] ?? backend}
                </span>
              }
            />
          ) : null}
          {status && availabilityView.kind === "ready" ? (
            <SettingsRow
              title="Capabilities"
              description={dedicatedSeatDescription}
              status={capabilitySummary(status.capabilities)}
            />
          ) : null}
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSection title="Computer pane">
        <SettingsRow
          title="Open automatically"
          description="Open the Computer pane the first time an agent acts on the desktop in a chat. Closing the pane keeps it closed for the rest of that chat's run."
          resetAction={
            settings.autoOpenComputerPane !== defaults.autoOpenComputerPane ? (
              <SettingResetButton
                label="open automatically"
                onClick={() =>
                  updateSettings({ autoOpenComputerPane: defaults.autoOpenComputerPane })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenComputerPane}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenComputerPane: Boolean(checked) })
              }
              aria-label="Open the Computer pane automatically when an agent drives the desktop"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Computer control">
        <SettingsRow
          title="Allow agents to control the desktop in new chats"
          description="When the desktop backend is available, any agent in a new chat can act on the desktop when asked. Off by default — desktop access, including screenshots, is an explicit opt-in. Individual chats can still be switched either way from the composer's mode menu, and doing so never changes this setting."
          resetAction={
            settings.allowComputerControlInNewChats !== defaults.allowComputerControlInNewChats ? (
              <SettingResetButton
                label="allow agents to control the desktop in new chats"
                onClick={() =>
                  updateSettings({
                    allowComputerControlInNewChats: defaults.allowComputerControlInNewChats,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.allowComputerControlInNewChats}
              onCheckedChange={(checked) =>
                updateSettings({ allowComputerControlInNewChats: Boolean(checked) })
              }
              aria-label="Allow agents to control the desktop in new chats"
            />
          }
        />
        <SettingsRow
          title="Per-chat control"
          description="Switch computer control for a single chat from the composer's mode menu (the Full access picker); the mode button shows a monitor icon while it is on. Desktop actions then ask for approval as they run, and clipboard reads always ask."
        />
      </SettingsSection>
    </div>
  );
}
