// FILE: RemoteAccessSettingsPanel.tsx
// Purpose: Configure the desktop-owned Mobile Companion and manage paired devices.
// Layer: Settings feature

import type {
  DesktopPairedDevice,
  DesktopPairingLink,
  DesktopRemoteAccessSettingsPatch,
  DesktopRemoteAccessStatus,
  DesktopTailscaleDiagnostics,
} from "@synara/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { CentralIcon } from "~/lib/central-icons";
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import {
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME,
  SETTINGS_INSET_LIST_CLASS_NAME,
} from "~/settingsPanelStyles";
import {
  canPairRemoteAccessDevice,
  deriveRemoteAccessHealth,
  formatPairingCode,
  formatPairingCountdown,
} from "./RemoteAccessSettingsPanel.logic";

const DEFAULT_PORT = 3773;

type BusyOperation =
  | "settings"
  | "diagnostics"
  | "connection"
  | "pairing"
  | "devices"
  | null;

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The desktop control plane did not complete the request.";
}

function connectionLabel(diagnostics: DesktopTailscaleDiagnostics): string {
  switch (diagnostics.connectionState) {
    case "connected":
      return diagnostics.dnsName ? `Connected as ${diagnostics.dnsName}` : "Connected";
    case "signed-out":
      return "Tailscale needs sign-in";
    case "stopped":
      return "Tailscale is stopped";
    case "unavailable":
      return "Tailscale CLI not found";
    default:
      return "Tailscale status unavailable";
  }
}

function serveLabel(diagnostics: DesktopTailscaleDiagnostics): string {
  if (diagnostics.funnelEnabled) return "Public Funnel detected";
  switch (diagnostics.serveState) {
    case "matching":
      return "Private HTTPS route verified";
    case "not-configured":
      return "Serve is not configured";
    case "different-target":
      return "Serve points somewhere else";
    case "unavailable":
      return "Serve status unavailable";
    default:
      return "Serve configuration could not be read";
  }
}

function RemoteStatusBadge({ status }: { status: DesktopRemoteAccessStatus }) {
  const health = deriveRemoteAccessHealth(status);
  return <Badge variant={health.variant}>{health.label}</Badge>;
}

function LoadingButtonContents({ loading, children }: { loading: boolean; children: string }) {
  return (
    <>
      {loading ? <Loader2Icon className="animate-spin" /> : null}
      {children}
    </>
  );
}

export function RemoteAccessSettingsPanel() {
  const bridge =
    typeof window === "undefined" ? undefined : window.desktopBridge?.remoteAccess;
  const [status, setStatus] = useState<DesktopRemoteAccessStatus | null>(null);
  const [devices, setDevices] = useState<ReadonlyArray<DesktopPairedDevice>>([]);
  const [pairing, setPairing] = useState<DesktopPairingLink | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingLabel, setPairingLabel] = useState("");
  const [portDraft, setPortDraft] = useState(String(DEFAULT_PORT));
  const [originDraft, setOriginDraft] = useState("");
  const [busy, setBusy] = useState<BusyOperation>(null);
  const [loading, setLoading] = useState(Boolean(bridge));
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const syncStatus = useCallback((next: DesktopRemoteAccessStatus) => {
    setStatus(next);
    setPortDraft(String(next.settings.port));
    setOriginDraft(next.settings.trustedOrigin ?? "");
  }, []);

  const loadDevices = useCallback(async () => {
    if (!bridge) return;
    const nextDevices = await bridge.listDevices();
    setDevices(nextDevices.filter((device) => device.accessProfile === "companion"));
  }, [bridge]);

  const load = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        bridge.getStatus(),
        bridge.listDevices(),
      ]);
      syncStatus(nextStatus);
      setDevices(nextDevices.filter((device) => device.accessProfile === "companion"));
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [bridge, syncStatus]);

  useEffect(() => {
    void load();
    if (!bridge) return;
    return bridge.onState((next) => syncStatus(next));
  }, [bridge, load, syncStatus]);

  useEffect(() => {
    if (!pairing) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void import("qrcode")
      .then(({ toDataURL }) =>
        toDataURL(pairing.pairingUrl, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 224,
          color: { dark: "#111111", light: "#ffffff" },
        }),
      )
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  useEffect(() => {
    if (!pairing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const health = useMemo(() => (status ? deriveRemoteAccessHealth(status) : null), [status]);
  const pairingExpired = pairing ? new Date(pairing.expiresAt).getTime() <= now : false;
  const canPair = status ? canPairRemoteAccessDevice(status) : false;

  const updateSettings = useCallback(
    async (patch: DesktopRemoteAccessSettingsPatch) => {
      if (!bridge || busy) return;
      setBusy("settings");
      setError(null);
      try {
        const next = await bridge.updateSettings(patch);
        syncStatus(next);
        if (patch.enabled === false) setPairing(null);
      } catch (cause) {
        const message = getErrorMessage(cause);
        setError(message);
        toastManager.add({ type: "error", title: "Remote access was not updated", description: message });
      } finally {
        setBusy(null);
      }
    },
    [bridge, busy, syncStatus],
  );

  const copyPairingValue = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add({ type: "success", title: `${label} copied` });
    } catch {
      toastManager.add({ type: "error", title: `Could not copy ${label.toLowerCase()}` });
    }
  }, []);

  if (!bridge) {
    return (
      <Alert variant="info">
        <CentralIcon name="devices" className="size-4" />
        <AlertTitle>Available in the Synara desktop app</AlertTitle>
        <AlertDescription>
          Mobile Companion setup uses desktop-only owner controls and cannot be changed from a
          browser session.
        </AlertDescription>
      </Alert>
    );
  }

  if (loading && !status) {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="animate-spin" />
        Loading remote access status…
      </div>
    );
  }

  if (!status) {
    return (
      <Alert variant="error">
        <CircleAlertIcon className="size-4" />
        <AlertTitle>Remote access status is unavailable</AlertTitle>
        <AlertDescription>
          <span>{error ?? "The desktop control plane is not ready."}</span>
          <Button size="xs" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const diagnostics = status.tailscale;

  return (
    <div className="space-y-6">
      <Alert variant="info">
        <CentralIcon name="devices" className="size-4" />
        <AlertTitle>Experimental · private Tailnet access</AlertTitle>
        <AlertDescription>
          Your computer remains the host and source of truth. Synara stays bound to loopback;
          Tailscale Serve provides private HTTPS access to phones signed in to your Tailnet.
          Never enable Funnel for this service.
        </AlertDescription>
      </Alert>

      {error ? (
        <Alert variant="error">
          <CircleAlertIcon className="size-4" />
          <AlertTitle>The last operation failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection title="Mobile Companion">
        <SettingsRow
          title="Remote access"
          description="Opt in to the restricted Companion API on a stable loopback port."
          status={health?.detail}
          control={
            <div className="flex items-center gap-2">
              <RemoteStatusBadge status={status} />
              <Switch
                checked={status.settings.enabled}
                disabled={busy !== null}
                onCheckedChange={(checked) => void updateSettings({ enabled: Boolean(checked) })}
                aria-label="Enable Mobile Companion remote access"
              />
            </div>
          }
        />
        <SettingsRow
          title="Companion port"
          description="The backend stays on 127.0.0.1. Port changes restart the local backend."
          status={status.backend.running ? `Backend listening on port ${status.backend.port ?? status.settings.port}` : "Backend is not running"}
          control={
            <div className="flex w-full gap-2 sm:w-auto">
              <Input
                className="w-full sm:w-28"
                type="number"
                min={1024}
                max={65535}
                value={portDraft}
                disabled={busy !== null}
                onChange={(event) => setPortDraft(event.target.value)}
                aria-label="Companion port"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || Number(portDraft) === status.settings.port}
                onClick={() => {
                  const port = Number(portDraft);
                  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                    setError("Companion port must be an integer from 1024 to 65535.");
                    return;
                  }
                  void updateSettings({ port });
                }}
              >
                Save
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Trusted Tailnet origin"
          description="Persist exactly one HTTPS .ts.net origin. Wildcards, paths, queries, and fragments are rejected."
          status={diagnostics?.discoveredOrigin && diagnostics.discoveredOrigin !== status.settings.trustedOrigin ? `Detected ${diagnostics.discoveredOrigin}` : undefined}
          control={
            <div className="flex w-full flex-col gap-2 sm:w-[26rem] sm:flex-row">
              <Input
                value={originDraft}
                disabled={busy !== null}
                onChange={(event) => setOriginDraft(event.target.value)}
                placeholder="https://machine.tailnet.ts.net"
                aria-label="Trusted Tailnet origin"
              />
              {diagnostics?.discoveredOrigin && diagnostics.discoveredOrigin !== originDraft ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => {
                    setOriginDraft(diagnostics.discoveredOrigin ?? "");
                    void updateSettings({ trustedOrigin: diagnostics.discoveredOrigin });
                  }}
                >
                  Use detected
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || originDraft.trim() === (status.settings.trustedOrigin ?? "")}
                onClick={() => void updateSettings({ trustedOrigin: originDraft.trim() || null })}
              >
                Save
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Keep Synara running"
          description="Closing the last window hides Synara to the tray so paired phones remain connected. Explicit Quit still stops the backend."
          control={
            <Switch
              checked={status.settings.keepRunningOnClose}
              disabled={busy !== null || !status.settings.enabled}
              onCheckedChange={(checked) =>
                void updateSettings({ keepRunningOnClose: Boolean(checked) })
              }
              aria-label="Keep Synara running in the tray"
            />
          }
        />
        <SettingsRow
          title="Launch at login"
          description="Start Synara after signing in so Mobile Companion becomes available without opening a window."
          control={
            <Switch
              checked={status.settings.launchAtLogin}
              disabled={busy !== null}
              onCheckedChange={(checked) => void updateSettings({ launchAtLogin: Boolean(checked) })}
              aria-label="Launch Synara at login"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Tailscale Serve">
        <SettingsRow
          title="Tailscale"
          description="Synara reads CLI status only. It never signs in, authorizes, or changes Serve automatically."
          status={diagnostics ? connectionLabel(diagnostics) : "Diagnostics have not run yet"}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("diagnostics");
                setError(null);
                try {
                  syncStatus(await bridge.refreshDiagnostics());
                } catch (cause) {
                  setError(getErrorMessage(cause));
                } finally {
                  setBusy(null);
                }
              }}
            >
              <LoadingButtonContents loading={busy === "diagnostics"}>Refresh</LoadingButtonContents>
            </Button>
          }
        />
        <SettingsRow
          title="Private HTTPS route"
          description="Run the guided command yourself. Existing Serve configuration is never reset automatically."
          status={diagnostics ? serveLabel(diagnostics) : "Waiting for diagnostics"}
          control={
            <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={!diagnostics || busy !== null}
                onClick={async () => {
                  const copied = await bridge.copyServeCommand();
                  toastManager.add({
                    type: copied ? "success" : "error",
                    title: copied ? "Serve command copied" : "Could not copy Serve command",
                  });
                }}
              >
                <CopyIcon />
                Copy Serve command
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!status.settings.enabled || !status.settings.trustedOrigin || busy !== null}
                onClick={async () => {
                  setBusy("connection");
                  setError(null);
                  try {
                    const result = await bridge.testConnection();
                    toastManager.add({
                      type: result.reachable ? "success" : "warning",
                      title: result.reachable ? "Mobile route is reachable" : "Mobile route is unavailable",
                      description: result.message,
                    });
                  } catch (cause) {
                    setError(getErrorMessage(cause));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <LoadingButtonContents loading={busy === "connection"}>Test route</LoadingButtonContents>
              </Button>
            </div>
          }
        >
          {diagnostics ? (
            <div className={cn("mt-3 space-y-2 px-3 py-2.5 text-xs", SETTINGS_INSET_LIST_CLASS_NAME)}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Expected target</span>
                <code className="min-w-0 truncate text-right text-foreground">{diagnostics.expectedProxyTarget}</code>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">Command</span>
                <code className="min-w-0 break-all text-right text-foreground">{diagnostics.expectedServeCommand}</code>
              </div>
              {diagnostics.proxyTargets.length > 0 ? (
                <div className="flex items-start justify-between gap-3">
                  <span className="shrink-0 text-muted-foreground">Current targets</span>
                  <span className="min-w-0 break-all text-right text-foreground">{diagnostics.proxyTargets.join(", ")}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="Reset Serve configuration"
          description={
            diagnostics?.funnelEnabled
              ? "Funnel can make the service public. Reset it yourself, then configure private Serve again."
              : "Copy the reset command when you intentionally want to remove Tailscale Serve routes. Synara never runs it for you."
          }
          status={
            diagnostics?.funnelEnabled ? (
              <span className="font-medium text-destructive">Public Funnel exposure detected</span>
            ) : undefined
          }
          control={
            <Button
              size="sm"
              variant={diagnostics?.funnelEnabled ? "destructive-outline" : "outline"}
              disabled={busy !== null}
              onClick={async () => {
                const copied = await bridge.copyServeResetCommand();
                toastManager.add({
                  type: copied ? "success" : "error",
                  title: copied ? "Reset command copied" : "Could not copy reset command",
                });
              }}
            >
              {diagnostics?.funnelEnabled ? <TriangleAlertIcon /> : <CopyIcon />}
              Copy reset command
            </Button>
          }
        />
        <SettingsRow
          title="Phone setup"
          description="Install Tailscale on the phone, sign in to the same Tailnet, and confirm this machine is reachable before opening the Mobile URL."
          status="The Companion is intentionally unavailable on the public internet."
        />
        <SettingsRow
          title="Mobile URL"
          description="Open this address only from a device signed in to the same Tailnet."
          status={status.mobileUrl ?? "Available after the Tailnet origin is saved"}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!status.mobileUrl || busy !== null}
              onClick={async () => {
                const copied = await bridge.copyMobileUrl();
                toastManager.add({
                  type: copied ? "success" : "error",
                  title: copied ? "Mobile URL copied" : "Could not copy mobile URL",
                });
              }}
            >
              <CopyIcon />
              Copy URL
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Pair a device">
        <SettingsRow
          title="One-time pairing code"
          description="Codes are valid for five minutes and can be used once. The phone receives restricted Companion access only."
          status={!canPair ? "Finish private HTTPS setup before creating a code." : undefined}
          control={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Input
                value={pairingLabel}
                maxLength={64}
                disabled={!canPair || busy !== null}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder="Device label (optional)"
                aria-label="New device label"
              />
              <Button
                size="sm"
                disabled={!canPair || busy !== null}
                onClick={async () => {
                  setBusy("pairing");
                  setError(null);
                  try {
                    const nextPairing = await bridge.createPairingLink(
                      pairingLabel.trim() ? { label: pairingLabel.trim() } : undefined,
                    );
                    setPairing(nextPairing);
                    setPairingLabel("");
                    setNow(Date.now());
                  } catch (cause) {
                    setError(getErrorMessage(cause));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <LoadingButtonContents loading={busy === "pairing"}>
                  {pairing && !pairingExpired ? "Replace code" : "Generate code"}
                </LoadingButtonContents>
              </Button>
            </div>
          }
        >
          <DisclosureRegion open={pairing !== null} className="mt-3">
            {pairing ? (
              <div
                className={cn(
                  "grid gap-4 px-4 py-4 sm:grid-cols-[14rem_minmax(0,1fr)]",
                  SETTINGS_INSET_LIST_CLASS_NAME,
                  pairingExpired && "opacity-70",
                )}
              >
                <div className="flex aspect-square items-center justify-center rounded-lg bg-white p-2">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="QR code for pairing this phone with Synara"
                      className="size-full"
                    />
                  ) : (
                    <Loader2Icon className="size-6 animate-spin text-black/60" />
                  )}
                </div>
                <div className="flex min-w-0 flex-col justify-center gap-3">
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">Manual code</div>
                    <code className="mt-1 block break-all text-xl font-semibold tracking-[0.15em] text-foreground">
                      {formatPairingCode(pairing.credential)}
                    </code>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {pairingExpired ? (
                      <CircleAlertIcon className="text-destructive" />
                    ) : (
                      <CheckIcon className="text-success" />
                    )}
                    <span className={pairingExpired ? "text-destructive" : "text-muted-foreground"}>
                      {pairingExpired ? "This code has expired" : `Expires in ${formatPairingCountdown(pairing.expiresAt, now)}`}
                    </span>
                  </div>
                  <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
                    The QR contains the token in a URL fragment, so it is not sent in HTTP request
                    logs. Synara clears the fragment immediately after exchange.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pairingExpired}
                      onClick={() => void copyPairingValue(pairing.credential, "Pairing code")}
                    >
                      <CopyIcon />
                      Copy code
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pairingExpired}
                      onClick={() => void copyPairingValue(pairing.pairingUrl, "Pairing link")}
                    >
                      <CopyIcon />
                      Copy link
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </DisclosureRegion>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Paired devices">
        <SettingsRow
          title="Device access"
          description="Revocation immediately ends active Companion sockets and removes notification subscriptions."
          status={`${devices.length} paired ${devices.length === 1 ? "device" : "devices"}`}
          control={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy("devices");
                  try {
                    await loadDevices();
                  } catch (cause) {
                    setError(getErrorMessage(cause));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "devices" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                Refresh
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={devices.length === 0 || busy !== null}
                onClick={async () => {
                  const confirmed = await window.desktopBridge?.confirm(
                    "Revoke every paired Mobile Companion device? Active connections and notifications will stop immediately.",
                  );
                  if (!confirmed) return;
                  setBusy("devices");
                  try {
                    const count = await bridge.revokeAllDevices();
                    await loadDevices();
                    toastManager.add({
                      type: "success",
                      title: count === 1 ? "1 device revoked" : `${count} devices revoked`,
                    });
                  } catch (cause) {
                    setError(getErrorMessage(cause));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Revoke all
              </Button>
            </div>
          }
        >
          {devices.length > 0 ? (
            <div className={cn("mt-3", SETTINGS_INSET_LIST_CLASS_NAME, "divide-y divide-[color:var(--color-border)]")}>
              {devices.map((device) => {
                const detail = [device.deviceType, device.os, device.browser]
                  .filter((value): value is string => Boolean(value))
                  .join(" · ");
                return (
                  <SettingsListRow
                    key={device.sessionId}
                    title={
                      <span className="flex items-center gap-2">
                        <span className={cn("size-2 rounded-full", device.connected ? "bg-success" : "bg-muted-foreground/40")} />
                        {device.label ?? "Mobile device"}
                      </span>
                    }
                    description={
                      <span>
                        {detail || "Companion client"}
                        {" · "}
                        {device.connected
                          ? "Connected now"
                          : device.lastConnectedAt
                            ? `Last connected ${formatRelativeTime(device.lastConnectedAt)}`
                            : "Not connected yet"}
                        {" · "}Expires {new Date(device.expiresAt).toLocaleDateString()}
                      </span>
                    }
                    actions={
                      <Button
                        size="sm"
                        variant="destructive-outline"
                        disabled={busy !== null}
                        onClick={async () => {
                          const confirmed = await window.desktopBridge?.confirm(
                            `Revoke ${device.label ?? "this mobile device"}? Its active connection and notifications will stop immediately.`,
                          );
                          if (!confirmed) return;
                          setBusy("devices");
                          try {
                            await bridge.revokeDevice(device.sessionId);
                            await loadDevices();
                            toastManager.add({ type: "success", title: "Device revoked" });
                          } catch (cause) {
                            setError(getErrorMessage(cause));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    }
                  />
                );
              })}
            </div>
          ) : (
            <div className={cn("mt-3 px-3 py-4 text-center text-xs text-muted-foreground", SETTINGS_INSET_LIST_CLASS_NAME)}>
              No Mobile Companion devices are paired yet.
            </div>
          )}
        </SettingsRow>
      </SettingsSection>

      <div className={cn("pt-1 text-center text-xs text-muted-foreground", SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME)}>
        Turning remote access off leaves your Tailscale Serve configuration and paired-device
        records unchanged. Use Revoke all and copy the reset command separately when needed.
      </div>
    </div>
  );
}
