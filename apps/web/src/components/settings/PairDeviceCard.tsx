// FILE: PairDeviceCard.tsx
// Purpose: Show an owner-issued, short-lived pairing link without persisting its credential.
// Layer: Settings UI; authentication and one-use enforcement remain server-owned.

import { DateTime } from "effect";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { buildPairingUrl, normalizeRemotePairingOrigin } from "@synara/shared/pairingUrl";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsRow } from "./SettingsPanelPrimitives";

type PairingState = {
  generation: number;
  expiresAtMs: number;
} & ({ kind: "address"; credential: string } | { kind: "link"; url: string });

function pairingExpiryMs(value: unknown): number {
  // HTTP auth responses contain ISO strings; native consumers may provide the
  // DateTime.Utc value declared by the contract. Reject malformed wire dates.
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return Number.NaN;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return Number.NaN;
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`,
  );
  return new Date(milliseconds).toISOString() === normalized ? milliseconds : Number.NaN;
}

export function PairDeviceCard() {
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverAddress, setServerAddress] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copiedGeneration, setCopiedGeneration] = useState<number | null>(null);
  const generation = useRef(0);
  const addressInputId = useId();
  const { copyToClipboard, isCopied } = useCopyToClipboard<number>({
    onCopy: setCopiedGeneration,
    // Clipboard errors must not log or echo the credential-bearing value.
    onError: () => setError("Could not copy the pairing link. Select and copy the link instead."),
  });

  useEffect(
    () => () => {
      // Ignore credentials returned after settings closes or the owner session
      // disappears. The parent unmounts this component in both cases.
      generation.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!pairing) return;
    const refresh = () => {
      if (generation.current !== pairing.generation) return;
      const now = Date.now();
      setNowMs(now);
      if (now >= pairing.expiresAtMs) {
        setPairing(null);
        setExpired(true);
      }
    };
    const timer = window.setTimeout(
      refresh,
      Math.min(2_147_483_647, Math.max(0, pairing.expiresAtMs - Date.now())),
    );
    const clock = window.setInterval(refresh, 1_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(clock);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [pairing]);

  const createPairingLink = useCallback(async () => {
    if (isCreating) return;
    const requestGeneration = ++generation.current;
    setPairing(null);
    setExpired(false);
    setError(null);
    setIsCreating(true);
    try {
      const issued = await ensureNativeApi().server.createAuthPairingToken();
      if (requestGeneration !== generation.current) return;
      const expiresAtMs = pairingExpiryMs(issued.expiresAt);
      const now = Date.now();
      if (
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= now ||
        typeof issued.credential !== "string" ||
        issued.credential.trim().length === 0
      ) {
        throw new Error("Invalid pairing credential response.");
      }
      const origin =
        normalizeRemotePairingOrigin(issued.pairingBaseUrl) ??
        normalizeRemotePairingOrigin(window.location.origin);
      setNowMs(now);
      setPairing(
        origin
          ? {
              kind: "link",
              generation: requestGeneration,
              expiresAtMs,
              url: buildPairingUrl(origin, issued.credential),
            }
          : {
              kind: "address",
              generation: requestGeneration,
              expiresAtMs,
              credential: issued.credential,
            },
      );
    } catch {
      if (requestGeneration === generation.current) {
        setError("Could not create a valid pairing link. Try creating a new one.");
      }
    } finally {
      if (requestGeneration === generation.current) setIsCreating(false);
    }
  }, [isCreating]);

  const confirmServerAddress = () => {
    if (pairing?.kind !== "address") return;
    if (Date.now() >= pairing.expiresAtMs) {
      setPairing(null);
      setExpired(true);
      return;
    }
    const origin = normalizeRemotePairingOrigin(serverAddress);
    if (!origin) {
      setError("Use this server's public or LAN address, such as https://synara.example.com.");
      return;
    }
    setError(null);
    // An unknown address is used only after the owner explicitly confirms it.
    setPairing({
      kind: "link",
      generation: pairing.generation,
      expiresAtMs: pairing.expiresAtMs,
      url: buildPairingUrl(origin, pairing.credential),
    });
  };

  const remainingSeconds = pairing
    ? Math.max(0, Math.ceil((pairing.expiresAtMs - nowMs) / 1_000))
    : 0;
  const expiryLabel = `Link expires in ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;

  return (
    <SettingsRow
      title="Pair a device"
      description="Create a one-time link for another device to sign into this server."
      status={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : undefined
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={isCreating}
          onClick={() => void createPairingLink()}
        >
          {isCreating ? "Creating..." : pairing ? "New link" : "Create pairing link"}
        </Button>
      }
    >
      {pairing?.kind === "address" ? (
        <form
          className="mt-3 space-y-3 border-t border-border/70 pt-3 text-ui-sm text-muted-foreground"
          onSubmit={(event) => {
            event.preventDefault();
            confirmServerAddress();
          }}
        >
          <p>
            Enter this Synara server's LAN or public address, including its port. Confirm an address
            the other device can reach before sharing the link.
          </p>
          <label htmlFor={addressInputId} className="block font-medium text-foreground">
            Server address
          </label>
          <Input
            id={addressInputId}
            type="url"
            value={serverAddress}
            onChange={(event) => setServerAddress(event.target.value)}
            placeholder="https://synara.example.com"
            autoComplete="off"
            spellCheck={false}
            maxLength={2_048}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="outline" type="submit">
              Use this address
            </Button>
            <span>{expiryLabel}</span>
          </div>
        </form>
      ) : pairing?.kind === "link" ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-border/70 pt-3 sm:flex-row sm:items-start">
          <div className="w-fit shrink-0 rounded-md bg-white p-2">
            <QRCodeSVG
              value={pairing.url}
              size={160}
              marginSize={4}
              role="img"
              aria-label="Pairing link QR code"
            />
          </div>
          <div className="min-w-0 space-y-2 text-ui-sm text-muted-foreground">
            <p className="break-all font-mono text-foreground" aria-label="Pairing link">
              {pairing.url}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  if (Date.now() >= pairing.expiresAtMs) {
                    setPairing(null);
                    setExpired(true);
                    return;
                  }
                  copyToClipboard(pairing.url, pairing.generation);
                }}
              >
                {isCopied && copiedGeneration === pairing.generation ? "Copied" : "Copy link"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  generation.current += 1;
                  setPairing(null);
                  setError(null);
                }}
              >
                Hide link
              </Button>
            </div>
            <p>{expiryLabel}</p>
            <p>
              Anyone with this link can sign in before it expires. Share it only with the device you
              want to connect.
            </p>
          </div>
        </div>
      ) : null}
      {expired ? (
        <p
          role="status"
          className="mt-3 border-t border-border/70 pt-3 text-ui-sm text-muted-foreground"
        >
          This pairing link has expired. Create a new one to pair a device.
        </p>
      ) : null}
    </SettingsRow>
  );
}
