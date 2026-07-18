// FILE: PairDeviceCard.tsx
// Purpose: Mint a pairing credential and show it as a QR code plus copyable link in settings.
// Layer: Settings UI components
// Exports: buildPairingUrl, PairDeviceCard

import { useCallback, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { Button } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { SettingsRow } from "~/components/settings/SettingsPanelPrimitives";

/**
 * Mirrors the server's `issueStartupPairingUrl` shape: the credential travels in the
 * URL hash so it never reaches server logs, and `/pair` exchanges it for a session.
 */
export function buildPairingUrl(origin: string, credential: string): string {
  const url = new URL("/pair", origin);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

function formatExpiry(expiresAt: string): string | null {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }
  const remainingMinutes = Math.round((expiresAtMs - Date.now()) / 60_000);
  if (remainingMinutes <= 0) {
    return "Expired";
  }
  if (remainingMinutes < 60) {
    return `Expires in ${remainingMinutes} min`;
  }
  const remainingHours = Math.round(remainingMinutes / 60);
  return `Expires in ${remainingHours} h`;
}

export function PairDeviceCard() {
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const createPairingLink = useCallback(async () => {
    if (isCreating) return;
    const api = readNativeApi() ?? ensureNativeApi();
    setIsCreating(true);
    setError(null);
    try {
      const issued = await api.server.createAuthPairingToken({ label: "paired-device" });
      setPairingUrl(buildPairingUrl(window.location.origin, issued.credential));
      setExpiresAt(String(issued.expiresAt));
    } catch (cause) {
      setPairingUrl(null);
      setExpiresAt(null);
      setError(cause instanceof Error ? cause.message : "Unable to create a pairing link.");
    } finally {
      setIsCreating(false);
    }
  }, [isCreating]);

  const expiryLabel = expiresAt ? formatExpiry(expiresAt) : null;

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
      {pairingUrl ? (
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
            <p>Anyone with this link can access this server until it expires.</p>
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}
