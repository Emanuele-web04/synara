import {
  IconArrowRight,
  IconDeviceMobile,
  IconKey,
  IconLock,
  IconShieldLock,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCompanion } from "../companionContext";
import { InlineError } from "../components/ui";
import {
  normalizePairingToken,
  pairingTokenLength,
  takeCapturedPairingToken,
} from "../lib/mobileLogic";
import { markPostPairOnboardingPending } from "../lib/onboarding";

export function PairingScreen() {
  const { pair } = useCompanion();
  const navigate = useNavigate();
  const fragmentToken = useMemo(() => takeCapturedPairingToken(), []);
  const [token, setToken] = useState(fragmentToken);
  const [deviceLabel, setDeviceLabel] = useState(defaultDeviceLabel);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(
    fragmentToken.length === pairingTokenLength ? Date.now() + 5 * 60_000 : null,
  );
  const [remainingSeconds, setRemainingSeconds] = useState(5 * 60);
  const countdownToken = useRef(fragmentToken);
  const automaticPairStarted = useRef(false);

  useEffect(() => {
    if (token.length !== pairingTokenLength) {
      countdownToken.current = token;
      setExpiresAt(null);
      return;
    }
    if (countdownToken.current !== token || expiresAt === null) {
      countdownToken.current = token;
      setExpiresAt(Date.now() + 5 * 60_000);
      setRemainingSeconds(5 * 60);
    }
  }, [expiresAt, token]);

  useEffect(() => {
    if (expiresAt === null) return;
    const update = () => setRemainingSeconds(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  async function submitPairing(nextToken = token) {
    const normalizedToken = normalizePairingToken(nextToken);
    if (normalizedToken.length !== pairingTokenLength || deviceLabel.trim().length < 2) return;
    if (remainingSeconds === 0) {
      setError("This pairing code has expired. Generate a new code in the desktop app.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await pair(normalizedToken, deviceLabel.trim());
      markPostPairOnboardingPending();
      await navigate({ to: "/onboarding", replace: true });
    } catch (pairError) {
      setError(
        pairError instanceof Error
          ? pairError.message
          : "The pairing code is invalid or has expired.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (fragmentToken.length !== pairingTokenLength || automaticPairStarted.current) return;
    automaticPairStarted.current = true;
    void submitPairing(fragmentToken);
  }, [fragmentToken]);

  return (
    <main className="pairing-screen">
      <header className="pairing-hero">
        <img src="/mobile/icons/synara.svg" alt="" width="58" height="58" />
        <p className="eyebrow">Private mobile companion</p>
        <h1>Connect to your Synara</h1>
        <p>Pair this device with the Synara app running on your computer.</p>
      </header>

      <form
        className="surface pairing-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submitPairing();
        }}
      >
        <label className="field-label" htmlFor="device-label">
          Device name
        </label>
        <div className="input-shell">
          <IconDeviceMobile aria-hidden="true" size={19} />
          <input
            id="device-label"
            name="device-label"
            value={deviceLabel}
            onChange={(event) => setDeviceLabel(event.target.value.slice(0, 80))}
            autoComplete="off"
            enterKeyHint="next"
            required
            minLength={2}
            maxLength={80}
          />
        </div>

        <label className="field-label" htmlFor="pairing-code">
          12-character pairing code
        </label>
        <div className="input-shell input-shell--code">
          <IconKey aria-hidden="true" size={19} />
          <input
            id="pairing-code"
            name="pairing-code"
            value={token}
            onChange={(event) => setToken(normalizePairingToken(event.target.value))}
            placeholder="AB12CD34EF56"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="one-time-code"
            inputMode="text"
            enterKeyHint="go"
            required
            minLength={pairingTokenLength}
            maxLength={pairingTokenLength}
            aria-describedby="pairing-code-help"
          />
        </div>
        <p className="field-help" id="pairing-code-help">
          Find this code under Remote Access &amp; Devices in the desktop app. It expires after
          five minutes.
          {token.length === pairingTokenLength ? (
            <strong> {remainingSeconds > 0 ? `About ${formatCountdown(remainingSeconds)} remaining.` : "Expired."}</strong>
          ) : null}
        </p>

        {error ? <InlineError>{error}</InlineError> : null}
        <button
          className="button button--primary button--wide"
          type="submit"
          disabled={
            submitting ||
            remainingSeconds === 0 ||
            token.length !== pairingTokenLength ||
            deviceLabel.trim().length < 2
          }
        >
          {submitting ? "Connecting…" : "Connect device"}
          {!submitting ? <IconArrowRight aria-hidden="true" size={19} /> : null}
        </button>
      </form>

      <div className="pairing-security">
        <div>
          <IconShieldLock aria-hidden="true" size={20} />
          <span>
            <strong>Tailnet only</strong>
            Your host stays private behind Tailscale.
          </span>
        </div>
        <div>
          <IconLock aria-hidden="true" size={20} />
          <span>
            <strong>Restricted access</strong>
            Mobile cannot browse files, open a terminal, or change projects.
          </span>
        </div>
      </div>
    </main>
  );
}

function defaultDeviceLabel(): string {
  const platform = navigator.platform.trim();
  return platform ? `${platform} companion` : "Mobile companion";
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
