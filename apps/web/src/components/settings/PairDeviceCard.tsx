// FILE: PairDeviceCard.tsx
// Purpose: Mint a pairing credential and show it as a QR code plus copyable link in settings.
// Layer: Settings UI components
// Exports: PairDeviceCard

import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { buildPairingUrl } from "@synara/shared/pairingUrl";

import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { SettingsRow } from "~/components/settings/SettingsPanelPrimitives";

function formatExpiry(expiresAt: string, nowMs: number): string | null {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }
  const remainingMinutes = Math.round((expiresAtMs - nowMs) / 60_000);
  if (remainingMinutes <= 0) {
    return null;
  }
  if (remainingMinutes < 60) {
    return `Expires in ${remainingMinutes} min`;
  }
  const remainingHours = Math.round(remainingMinutes / 60);
  return `Expires in ${remainingHours} h`;
}

function isExpired(expiresAt: string, nowMs: number): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

export function PairDeviceCard() {
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  // Pairing credentials are short-lived, so keep the expiry label and the
  // expired state current while the link is showing instead of freezing the
  // render-time value.
  useEffect(() => {
    if (!expiresAt) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(interval);
  }, [expiresAt]);

  const createPairingLink = useCallback(async () => {
    if (isCreating) return;
    const api = readNativeApi() ?? ensureNativeApi();
    setIsCreating(true);
    setError(null);
    try {
      const issued = await api.server.createAuthPairingToken({ label: "paired-device" });
      // Prefer the server-reported reachable origin: when the owner browses via
      // localhost, this browser's origin would send other devices to their own
      // loopback address.
      const origin = issued.pairingBaseUrl ?? window.location.origin;
      setPairingUrl(buildPairingUrl(origin, issued.credential));
      setExpiresAt(String(issued.expiresAt));
      setNowMs(Date.now());
    } catch (cause) {
      setPairingUrl(null);
      setExpiresAt(null);
      setError(cause instanceof Error ? cause.message : "Unable to create a pairing link.");
    } finally {
      setIsCreating(false);
    }
  }, [isCreating]);

  const expired = expiresAt !== null && isExpired(expiresAt, nowMs);
  const expiryLabel = expiresAt && !expired ? formatExpiry(expiresAt, nowMs) : null;
  const showLocalOriginHint =
    pairingUrl !== null && new URL(pairingUrl).hostname === "localhost" && !expired;

  return (
    <SettingsRow
      title="Pair a device"
      description="Create a one-time link that signs another device into this server. Scan the QR code or open the link on the other device."
      status={error ? <span className="text-destructive">{error}</span> : undefined}
      control={
        <Button size="xs" variant="outline" disabled={isCreating} onClick={createPairingLink}>
          {isCreating ? "Creating..." : pairingUrl ? "New link" : "Create pairing link"}
        </Button>
      }
    >
      {pairingUrl && !expired ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-border/70 pt-3 sm:flex-row sm:items-start">
          <div className="w-fit shrink-0 rounded-md bg-white p-2">
            <QRCodeSVG value={pairingUrl} size={160} aria-label="Pairing link QR code" />
          </div>
          <div className="min-w-0 space-y-2 text-xs text-muted-foreground">
            <p className="break-all font-mono text-[11px] text-foreground">{pairingUrl}</p>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => copyToClipboard(pairingUrl, undefined)}
              >
                {isCopied ? "Copied" : "Copy link"}
              </Button>
              {expiryLabel ? <span>{expiryLabel}</span> : null}
            </div>
            {showLocalOriginHint ? (
              <p>
                This link points at localhost, which other devices cannot reach. Open Synara via the
                server&apos;s LAN or public address and create the link again.
              </p>
            ) : null}
            <p>Anyone with this link can access this server until it expires.</p>
          </div>
        </div>
      ) : null}
      {pairingUrl && expired ? (
        <div className="mt-3 border-t border-border/70 pt-3 text-xs text-muted-foreground">
          This pairing link has expired. Create a new one to pair a device.
        </div>
      ) : null}
    </SettingsRow>
  );
}
