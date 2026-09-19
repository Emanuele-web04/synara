// FILE: ComputerSettingsPanel.tsx
// Purpose: Own the Computer use settings panel: desktop backend status and computer-control preferences.
// Layer: Settings UI components
// Exports: ComputerSettingsPanel

import {
  COMPUTER_HYPRLAND_BACKEND,
  COMPUTER_KWIN_BACKEND,
  COMPUTER_MAC_BACKEND,
  COMPUTER_NESTED_KWIN_BACKEND,
  COMPUTER_RELEASE_CONTROL_HOTKEY,
  COMPUTER_RELEASE_HOTKEY_BACKENDS,
  type ComputerCapabilities,
  type ComputerGrant,
  type ComputerGrantActionClass,
  type ComputerPermission,
} from "@synara/contracts";
import {
  COMPUTER_PERMISSION_KINDS,
  COMPUTER_PERMISSION_LABELS,
  listComputerPermissions,
} from "@synara/shared/computerGrants";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";

import {
  DEFAULT_AGENT_CURSOR_COLOR_MODE,
  normalizeCursorHexColor,
  type AgentCursorColorMode,
  type AppSettingsBinding,
  type ComputerPreviewSize,
} from "~/appSettings";
import type { DesktopAppSnapSettingsPane, DesktopAppSnapState } from "@synara/contracts";
import {
  computerLastFailureNote,
  computerReconnectsNote,
  computerStatusNeedsSetup,
  resolveComputerAvailabilityView,
} from "~/components/ComputerPanel.logic";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { useProvisionComputer } from "~/hooks/useProvisionComputer";
import { useRefreshOnWindowReturn } from "~/hooks/useRefreshOnWindowReturn";
import {
  AppSnapPermissionSection,
  COMPUTER_PERMISSION_PANES,
  useAppSnapPermissionGuideBridge,
} from "./AppSnapPermissionSection";
import {
  COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
  computerGrantsQueryOptions,
  computerStatusQueryOptions,
  revokeComputerGrant,
  serverQueryKeys,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { SettingResetButton, SettingsSegmentedControl } from "./SettingControls";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionShell,
  SettingsSection,
} from "./SettingsPanelPrimitives";

/** Stable identity, so the provision hook's toast copy is not rebuilt every render. */
const EMPTY_PERMISSIONS: readonly ComputerPermission[] = [];

const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  [COMPUTER_KWIN_BACKEND]: "KWin plugin (KDE)",
  [COMPUTER_HYPRLAND_BACKEND]: "Hyprland plugin",
  [COMPUTER_NESTED_KWIN_BACKEND]: "Isolated agent desktop (nested KWin)",
  [COMPUTER_MAC_BACKEND]: "macOS desktop",
  cua: "macOS desktop · Cua 0.28.2",
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
  { key: "focus", label: "keyboard focus" },
  { key: "raise", label: "window raising" },
  { key: "clipboard", label: "clipboard" },
  { key: "ghostCursor", label: "ghost cursor" },
];

/**
 * The abilities to read out. `captureAvailable` is live health, not a static
 * capability: a backend can advertise capture and still be unable to take a
 * frame because the OS has not granted it, and listing "screen capture" in that
 * state is the panel telling the user something the desktop cannot do.
 */
function capabilitySummary(capabilities: ComputerCapabilities, captureAvailable: boolean): string {
  const enabled = CAPABILITY_LABELS.filter(
    (entry) => capabilities[entry.key] && (entry.key !== "capture" || captureAvailable),
  ).map((entry) => entry.label);
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

/** How a grant's action classes read on its row — same words the approval card used. */
const GRANT_CLASS_LABELS: Record<ComputerGrantActionClass, string> = {
  observe: "screen reads",
  input: "clicks and typing",
  lifecycle: "app and window control",
  clipboard: "clipboard use",
  browser: "browser actions",
};

/** One grant row's title: the app it covers, or the whole desktop for an any-app grant. */
function computerGrantTitle(grant: ComputerGrant): string {
  if (grant.app === null) return "Any app";
  return grant.app.name ?? grant.app.bundleId ?? "Unnamed app";
}

/**
 * What the grant covers and for how much longer — the row's second line, so
 * the scope and the clock are visible together rather than in a tooltip.
 */
function computerGrantDescription(grant: ComputerGrant, now: number): string {
  const classes = grant.classes.map((entry) => GRANT_CLASS_LABELS[entry]).join(" + ");
  const remainingMs = Date.parse(grant.expiresAt) - now;
  const expiry =
    remainingMs <= 0
      ? "expired — will be dropped on next use"
      : `expires in ${formatRemaining(remainingMs)}`;
  const identity =
    grant.app?.bundleId !== undefined && grant.app.bundleId !== grant.app.name
      ? ` · ${grant.app.bundleId}`
      : "";
  const used = grant.lastUsedAt
    ? ` · last used ${formatRemaining(now - Date.parse(grant.lastUsedAt))} ago`
    : "";
  return `${classes}${identity} · ${expiry}${used}`;
}

function formatRemaining(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes >= 24 * 60) {
    const days = Math.round(minutes / (24 * 60));
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * One agent-cursor color field: a validated hex input and the swatch it
 * resolves to. Only a complete `#rrggbb` (or an intentional clear) commits to
 * settings, so a half-typed value never reaches the stored preference.
 */
function CursorColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Follow a committed value that landed from elsewhere (Reset, another
  // window) instead of stranding the field on the old draft.
  useEffect(() => setDraft(value), [value]);
  const resolved = normalizeCursorHexColor(value);
  const draftIsValid = draft.trim() === "" || normalizeCursorHexColor(draft) !== "";
  return (
    <label className="flex items-center gap-2">
      <span className="w-7 shrink-0 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
        {label}
      </span>
      <span
        aria-hidden
        data-swatch={resolved || "stock"}
        className={cn(
          "size-4 shrink-0 rounded-full border border-[color:var(--color-border)]",
          !resolved && "bg-transparent",
        )}
        style={resolved ? { backgroundColor: resolved } : undefined}
      />
      <Input
        size="sm"
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === "") {
            onChange("");
            return;
          }
          const normalized = normalizeCursorHexColor(next);
          if (normalized) onChange(normalized);
        }}
        onBlur={() => setDraft(value)}
        placeholder="#rrggbb"
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${label} color`}
        aria-invalid={!draftIsValid}
        className="w-24"
      />
    </label>
  );
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
  // The durable always-allow grants: minted on approval cards, listed and
  // revoked here. Same poll cadence as status — expiry alone can change what
  // the list shows, and a grant created from a chat card should appear while
  // the panel is open without a manual refresh.
  const grantsQuery = useQuery({
    ...computerGrantsQueryOptions({ enabled: active }),
    refetchInterval: active ? COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS : false,
  });
  const revokeGrant = useMutation({
    mutationFn: (grantId: string) => revokeComputerGrant(grantId),
    // The revoke answer already carries the post-delete list, so the panel
    // reflects it without waiting on the next poll.
    onSuccess: (result) => {
      queryClient.setQueryData(serverQueryKeys.computerGrants(), (current) =>
        current === undefined ? current : { ...current, grants: result.grants },
      );
    },
  });

  const status = statusQuery.data;
  const [appSnapState, setAppSnapState] = useState<DesktopAppSnapState | null>(null);
  const [guidePane, setGuidePane] = useState<DesktopAppSnapSettingsPane | null>(null);
  // The native permission surface is the AppSnap helper: the same coach that
  // AppSnap's own settings drive, asked about the computer-use grant set.
  const hasNativePermissionSetup = typeof window !== "undefined" && !!window.desktopBridge?.appSnap;
  // Returning from System Settings must re-pull both the server status and the
  // native grant snapshot — the toggle the user just flipped lives in the
  // second one.
  const refreshPermissionState = useCallback(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    void bridge
      .getState(COMPUTER_PERMISSION_KINDS)
      .then((next) => setAppSnapState(next))
      .catch(() => undefined);
  }, []);
  useRefreshOnWindowReturn(() => {
    void statusQuery.refetch({ cancelRefetch: false });
    refreshPermissionState();
  }, active);

  // Panel-level on purpose: hooks above the `!active` return stay mounted while
  // the surface is hidden, so a dismissed coach still clears the remembered
  // pane instead of resurrecting the guide on return.
  useAppSnapPermissionGuideBridge({
    permissionKinds: COMPUTER_PERMISSION_KINDS,
    onStateChange: setAppSnapState,
    onGuidePaneChange: setGuidePane,
  });

  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge || !active) return;
    let disposed = false;
    const unsubscribe = bridge.onState((state) => {
      if (!disposed) setAppSnapState(state);
    });
    void bridge
      .getState(COMPUTER_PERMISSION_KINDS)
      .then((next) => {
        if (!disposed) setAppSnapState(next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [active]);
  /**
   * The grants the OS is withholding, named. The availability message already
   * explains what to do; the row below is the checklist — the thing a user can
   * glance at after flipping a switch to see whether the other one is still off.
   */
  const missingPermissions =
    status?.availability.kind === "permission-required"
      ? status.availability.missing
      : EMPTY_PERMISSIONS;
  // The same provision the chat's setup card runs, through the same hook: one
  // call in flight at a time whichever surface started it, and one account of
  // what happened. This surface keeps that account inline rather than as a
  // toast, because it has room for it and is where the user is already looking.
  const setup = useProvisionComputer({ missing: missingPermissions });
  /**
   * Re-arm state for the physical-Escape kill switch. The hooks sit above the
   * `!active` return like every other state on this panel; the relay itself is
   * the user's explicit `computer.rearmInput`, and a failed relay keeps the
   * stop rather than reporting authority the driver does not have.
   */
  const [rearmPending, setRearmPending] = useState(false);
  const [rearmError, setRearmError] = useState<string | null>(null);
  const rearmInput = async () => {
    if (rearmPending) return;
    setRearmPending(true);
    setRearmError(null);
    try {
      const api = ensureNativeApi();
      if (!api.computer?.rearmInput) {
        throw new Error("This app build cannot re-arm computer input.");
      }
      await api.computer.rearmInput({});
      await statusQuery.refetch();
    } catch (error) {
      setRearmError(
        error instanceof Error && error.message
          ? error.message
          : "The re-arm request failed. Try again.",
      );
    } finally {
      setRearmPending(false);
    }
  };

  if (!active) return null;

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
  // How this backend shares the machine, in the user's terms. macOS is the one
  // backend with no seat of its own: it drives the desktop the human is looking
  // at. Elsewhere, the emergency release is a shortcut the compositor plugin
  // (KWin or Hyprland) registers with the compositor — no other backend binds
  // it, and a nested offscreen session never hears the human's keys, so only a
  // visible plugin-backed desktop may promise it.
  const capabilitiesDescription =
    backend === COMPUTER_MAC_BACKEND || backend === "cua"
      ? "The agent shares your Mac desktop. An authorized Computer task can switch apps and bring its target window forward. Background input may also affect focus. Stop ends desktop control; the drawn cursor is a visual indicator, not a separate keyboard focus. Pressing the physical Escape key while the agent drives stops all computer input until you re-arm it."
      : backend !== null &&
          COMPUTER_RELEASE_HOTKEY_BACKENDS.includes(backend) &&
          status?.capabilities.visibleDesktop === true
        ? `The agent shares the computer described by this backend. Press ${COMPUTER_RELEASE_CONTROL_HOTKEY} at any time to stop it from acting on the desktop, and press it again to let it resume.`
        : "The agent drives its own seat, so your cursor and focus stay untouched.";
  /**
   * Screen capture is granted separately from input on every backend that has a
   * permission model at all, so a desktop can be fully driveable and still
   * blind.
   *
   * The two readings differ on purpose. `captureUnavailable` is "nothing has
   * proved capture works", which is also true of a backend nobody has engaged
   * yet — enough to offer Set up, not enough to accuse the OS of refusing.
   * `captureBlocked` is the refusal itself: a helper that is running and still
   * cannot see. Only that one earns a warning, and without it the card is
   * entirely green while every screenshot fails.
   */
  const captureUnavailable = health?.captureAvailable === false;
  const captureBlocked = captureUnavailable && health?.status === "connected";
  // A missing background delivery route never authorizes foreground fallback.
  const backgroundInputDegraded = health?.backgroundInputDegraded === true;
  // Shared with the chat's setup card, which asks the same question of the same
  // status after pressing the same server-side Set up.
  const needsSetup = computerStatusNeedsSetup(status);
  // The same two sentences the pane's health badge composes, from the same
  // helpers: one account of a supervision state, however it is surfaced.
  const healthNotes = [
    computerReconnectsNote(health),
    availabilityView.kind === "ready" ? computerLastFailureNote(health) : null,
  ].filter((note): note is string => note !== null);
  /**
   * The physical-Escape kill is host-wide and outranks everything else on
   * this card: while it holds, no agent call, pane click, or keystroke
   * reaches the desktop. Re-arming is the user's explicit choice — the button
   * relays `computer.rearmInput`, and a failed relay keeps the stop rather
   * than reporting authority the driver does not have.
   */
  const inputStopped = status?.inputStopped === true;
  // Stock is the default and stores no override; only an explicit Custom
  // choice can differ from the default state.
  const cursorColorMode = settings.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE;
  const cursorColorsDirty =
    cursorColorMode !== (defaults.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE) ||
    (settings.agentCursorFillColor ?? "") !== (defaults.agentCursorFillColor ?? "") ||
    (settings.agentCursorRimColor ?? "") !== (defaults.agentCursorRimColor ?? "");

  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title="Desktop backend"
        action={
          <div className="flex items-center gap-2">
            {/* Offered whenever the desktop is not ready. Setting up installs
                whatever this backend still needs — on Linux, distribution
                packages through the system's own authorization dialog and
                Synara's compositor plugin into the user's home; on macOS, the
                native helper plus the Accessibility and Screen Recording grants
                macOS asks for — and boots the agent's desktop. */}
            {needsSetup && !statusQuery.isError ? (
              <Button
                size="xs"
                variant="default"
                disabled={setup.isPending}
                onClick={setup.provision}
              >
                {setup.isPending ? "Setting up…" : "Set up"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={statusQuery.isFetching || setup.isPending}
              onClick={() => {
                void statusQuery.refetch();
                refreshPermissionState();
              }}
            >
              {statusQuery.isFetching ? "Checking…" : "Refresh"}
            </Button>
          </div>
        }
      >
        <SettingsCard>
          {inputStopped ? (
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-red-500" />
                  Input stopped — Escape was pressed
                </span>
              }
              description="The physical Escape key stopped all computer input. No agent action, pane click, or keystroke reaches the desktop until you re-arm it."
              status={rearmError ?? undefined}
              control={
                <Button
                  size="xs"
                  variant="default"
                  disabled={rearmPending}
                  onClick={() => void rearmInput()}
                >
                  {rearmPending ? "Re-arming…" : "Re-arm input"}
                </Button>
              }
            />
          ) : null}
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
            description={
              availabilityView.kind === "ready"
                ? "The desktop is ready. Turn on Computer control below to let the agent use the desktop."
                : availabilityView.description
            }
            status={[setup.note, ...healthNotes].filter(Boolean).join(" ") || undefined}
          />
          {backend ? (
            <SettingsRow
              title="Backend"
              description="Which computer backend serves perception and input."
              control={
                <span className="text-sm text-muted-foreground">
                  {BACKEND_DISPLAY_NAMES[backend] ?? backend}
                </span>
              }
            />
          ) : null}
          {missingPermissions.length > 0 && !hasNativePermissionSetup ? (
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-red-500" />
                  {`${listComputerPermissions(missingPermissions)} ${missingPermissions.length === 1 ? "is" : "are"} not allowed yet`}
                </span>
              }
              description="Turn Synara on for each of these in System Settings › Privacy & Security, then press Set up."
              status={missingPermissions
                .map((permission) => COMPUTER_PERMISSION_LABELS[permission])
                .join(" · ")}
            />
          ) : null}
          {hasNativePermissionSetup && appSnapState ? (
            <div className="p-3">
              {/* One permission section serves every surface; only the pane set
                  differs. The coach and settings deep links live in the shared
                  section, so Computer never grows a second guide stack. */}
              <AppSnapPermissionSection
                panes={COMPUTER_PERMISSION_PANES}
                permissionKinds={COMPUTER_PERMISSION_KINDS}
                feature="Computer control"
                state={appSnapState}
                onStateChange={setAppSnapState}
                guidePane={guidePane}
                onGuidePaneChange={setGuidePane}
              />
            </div>
          ) : null}
          {captureBlocked && missingPermissions.length === 0 ? (
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />
                  Screen capture is not allowed yet
                </span>
              }
              description={
                backend === COMPUTER_MAC_BACKEND
                  ? "The agent can act on the desktop but cannot see it, so screenshots fail. Turn Synara on in System Settings › Privacy & Security › Screen Recording, then press Set up to reconnect."
                  : "The agent can act on the desktop but cannot see it, so screenshots fail. Press Set up to reconnect."
              }
            />
          ) : null}
          {backgroundInputDegraded ? (
            <SettingsRow
              title="Background typing is limited"
              description="Some applications may refuse background typing or leave its effect uncertain. An authorized Computer task can use foreground delivery after a confirmed refusal; uncertain input must be inspected before another action."
            />
          ) : null}
          {status && availabilityView.kind === "ready" ? (
            <SettingsRow
              title="Capabilities"
              description={capabilitiesDescription}
              status={capabilitySummary(status.capabilities, !captureBlocked)}
            />
          ) : null}
        </SettingsCard>
      </SettingsSectionShell>

      {/* On a backend that drives the visible desktop the pane defaults to
          stills-only (interactive mode stays off — a second cursor on the
          user's own screen is worse than none), but the preview itself is
          wanted: watching the agent's captured view inside the app is how a
          user follows background work in windows they are not looking at. */}
      <SettingsSection title="Computer preview">
        <SettingsRow
          title="Open automatically"
          description="Show the live computer preview the first time an agent acts on the desktop in a chat. Closing the preview keeps it hidden for the rest of that chat's run."
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
              aria-label="Show the computer preview automatically when an agent drives the desktop"
            />
          }
        />
        <SettingsRow
          title="Preview size"
          description="Compact keeps the in-chat preview small and glanceable; large gives it the full wide card."
          resetAction={
            settings.computerPreviewSize !== defaults.computerPreviewSize ? (
              <SettingResetButton
                label="preview size"
                onClick={() =>
                  updateSettings({ computerPreviewSize: defaults.computerPreviewSize })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl<ComputerPreviewSize>
              value={settings.computerPreviewSize}
              onValueChange={(value) => updateSettings({ computerPreviewSize: value })}
              options={[
                { value: "compact", label: "Compact" },
                { value: "large", label: "Large" },
              ]}
              ariaLabel="In-chat computer preview size"
            />
          }
        />
      </SettingsSection>

      {/* The agent's on-screen pointer. Stock keeps the driver's monochrome
          cursor and stores nothing beyond the default; Custom is the only
          state that carries fill/rim overrides to the desktop cursor host. */}
      <SettingsSection title="Agent cursor">
        <SettingsRow
          title="Cursor colors"
          description="The agent pointer is stock monochrome by default — like a normal pointer. Custom colors apply to new computer sessions."
          resetAction={
            cursorColorsDirty ? (
              <SettingResetButton
                label="cursor colors"
                onClick={() =>
                  updateSettings({
                    agentCursorColorMode:
                      defaults.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE,
                    agentCursorFillColor: defaults.agentCursorFillColor ?? "",
                    agentCursorRimColor: defaults.agentCursorRimColor ?? "",
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl<AgentCursorColorMode>
              value={cursorColorMode}
              onValueChange={(value) => updateSettings({ agentCursorColorMode: value })}
              options={[
                { value: "stock", label: "Stock" },
                { value: "custom", label: "Custom" },
              ]}
              ariaLabel="Agent cursor colors"
            />
          }
        >
          {cursorColorMode === "custom" ? (
            <div className="flex flex-col gap-2 pt-3 sm:flex-row sm:gap-4">
              <CursorColorField
                label="Fill"
                value={settings.agentCursorFillColor ?? ""}
                onChange={(value) => updateSettings({ agentCursorFillColor: value })}
              />
              <CursorColorField
                label="Rim"
                value={settings.agentCursorRimColor ?? ""}
                onChange={(value) => updateSettings({ agentCursorRimColor: value })}
              />
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Computer control">
        <SettingsRow
          title="Computer control"
          description="Let the agent use the desktop in any chat. Approval gates and Stop still apply."
          resetAction={
            settings.computerControlEnabled !== defaults.computerControlEnabled ? (
              <SettingResetButton
                label="computer control"
                onClick={() =>
                  updateSettings({ computerControlEnabled: defaults.computerControlEnabled })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.computerControlEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ computerControlEnabled: Boolean(checked) })
              }
              aria-label="Let the agent use the desktop in any chat"
            />
          }
        />
      </SettingsSection>

      {/* The durable consents minted by "Always allow" answers on computer
          approval cards. Every row names the app and the action classes it
          covers, how long it has left, and a Revoke that takes effect on the
          next gated call — grants only ever waive the prompt, never the
          denylist or the kill switch. */}
      <SettingsSection title="Always allowed">
        {grantsQuery.isError ? (
          <SettingsRow
            title="Always-allow grants are unavailable"
            description="This build cannot read the grant list. Grants still apply; they expire on their own."
          />
        ) : (grantsQuery.data?.grants.length ?? 0) === 0 ? (
          <SettingsRow
            title="No always-allow grants"
            description="When a computer approval offers Always allow, the grant it creates is listed here with its expiry. Approvals otherwise ask each time."
          />
        ) : (
          (grantsQuery.data?.grants ?? []).map((grant) => (
            <SettingsRow
              key={grant.id}
              title={computerGrantTitle(grant)}
              description={computerGrantDescription(grant, Date.now())}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={revokeGrant.isPending}
                  onClick={() => revokeGrant.mutate(grant.id)}
                >
                  Revoke
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>
    </div>
  );
}
