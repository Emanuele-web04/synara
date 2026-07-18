import { IconCloudOff, IconRefresh, IconShieldLock } from "@tabler/icons-react";
import { useState } from "react";
import { useCompanion } from "../companionContext";
import { InlineError } from "../components/ui";

export function OfflineScreen() {
  const { lastError, retry } = useCompanion();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function handleRetry() {
    setRetrying(true);
    setRetryError(null);
    try {
      await retry();
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "The host is still unavailable.");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <main className="full-screen-state offline-screen">
      <div className="state-icon state-icon--offline">
        <IconCloudOff aria-hidden="true" size={30} stroke={1.6} />
      </div>
      <p className="eyebrow">{window.location.hostname}</p>
      <h1>Your Synara host is offline</h1>
      <p className="state-description">
        The computer may be asleep, disconnected from Tailscale, or Synara may have quit.
        Conversation data is hidden while disconnected.
      </p>
      {retryError || lastError ? <InlineError>{retryError ?? lastError}</InlineError> : null}
      <button className="button button--primary button--wide" onClick={() => void handleRetry()} disabled={retrying}>
        <IconRefresh className={retrying ? "spin" : undefined} aria-hidden="true" size={19} />
        {retrying ? "Trying again…" : "Try again"}
      </button>
      <div className="privacy-note">
        <IconShieldLock aria-hidden="true" size={18} />
        <span>No conversations are stored for offline use.</span>
      </div>
    </main>
  );
}
