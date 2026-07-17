import {
  IconArrowRight,
  IconBell,
  IconBellCheck,
  IconCheck,
  IconDownload,
  IconMessage,
  IconShare3,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCompanion } from "../companionContext";
import { InlineError, LoadingBlock, ScreenHeader } from "../components/ui";
import type { NotificationSettings } from "../domain";
import {
  isCurrentDeviceIos,
  isCurrentDisplayStandalone,
  useInstallPrompt,
} from "../lib/install";
import { clearPostPairOnboardingPending } from "../lib/onboarding";

export function OnboardingScreen() {
  const {
    session,
    getNotificationSettings,
    subscribeToNotifications,
  } = useCompanion();
  const navigate = useNavigate();
  const { installPrompt, clearInstallPrompt } = useInstallPrompt();
  const [notifications, setNotifications] = useState<NotificationSettings | null>(null);
  const [busy, setBusy] = useState<"install" | "notifications" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installed = isCurrentDisplayStandalone();
  const ios = isCurrentDeviceIos();

  useEffect(() => {
    let active = true;
    void getNotificationSettings()
      .then((settings) => {
        if (active) setNotifications(settings);
      })
      .catch((loadError) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Notification support could not be checked.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [getNotificationSettings]);

  async function install() {
    if (!installPrompt) return;
    setBusy("install");
    setError(null);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") clearInstallPrompt();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : "Synara was not installed.");
    } finally {
      setBusy(null);
    }
  }

  async function enableNotifications() {
    setBusy("notifications");
    setError(null);
    try {
      // This is intentionally called only from this click handler. Browsers,
      // especially installed iOS web apps, require a direct user gesture.
      const next = await subscribeToNotifications(true);
      setNotifications(next);
    } catch (subscribeError) {
      setError(
        subscribeError instanceof Error
          ? subscribeError.message
          : "Notifications could not be enabled.",
      );
    } finally {
      setBusy(null);
    }
  }

  function finish() {
    clearPostPairOnboardingPending();
    void navigate({ to: "/", replace: true });
  }

  const requiresIosInstall = ios && !installed;

  return (
    <div className="screen onboarding-screen">
      <ScreenHeader eyebrow="Device connected" title="Finish mobile setup" />

      <section className="surface onboarding-welcome" aria-label="Pairing complete">
        <span className="onboarding-welcome__icon">
          <IconCheck aria-hidden="true" size={22} />
        </span>
        <div>
          <strong>{session?.deviceLabel ?? "This device"} is paired</strong>
          <p>Install the app and choose whether Synara may alert you in the background.</p>
        </div>
      </section>

      {error ? <InlineError>{error}</InlineError> : null}

      <ol className="onboarding-steps">
        <li className="surface onboarding-step">
          <span className="onboarding-step__number">1</span>
          <div className="onboarding-step__content">
            <div className="onboarding-step__heading">
              <IconDownload aria-hidden="true" size={21} />
              <div>
                <strong>{installed ? "Installed on your Home Screen" : "Install Synara"}</strong>
                <p>Use a full-screen app experience and more reliable background delivery.</p>
              </div>
            </div>

            {installed ? (
              <p className="onboarding-complete"><IconCheck aria-hidden="true" size={16} /> Ready</p>
            ) : ios ? (
              <div className="onboarding-guidance">
                <IconShare3 aria-hidden="true" size={18} />
                <span>
                  In Safari, tap <strong>Share</strong>, choose <strong>Add to Home Screen</strong>,
                  then open Synara from its new icon. Notifications can only be enabled there.
                </span>
              </div>
            ) : installPrompt ? (
              <button
                type="button"
                className="button button--secondary button--wide"
                disabled={busy !== null}
                onClick={() => void install()}
              >
                <IconDownload aria-hidden="true" size={18} />
                {busy === "install" ? "Opening install prompt..." : "Install Synara"}
              </button>
            ) : (
              <p className="onboarding-guidance">
                Open your browser menu and choose <strong>Install app</strong> or
                <strong> Add to Home Screen</strong>.
              </p>
            )}
          </div>
        </li>

        <li className="surface onboarding-step">
          <span className="onboarding-step__number">2</span>
          <div className="onboarding-step__content">
            <div className="onboarding-step__heading">
              {notifications?.subscribed ? (
                <IconBellCheck aria-hidden="true" size={21} />
              ) : (
                <IconBell aria-hidden="true" size={21} />
              )}
              <div>
                <strong>Background notifications</strong>
                <p>Get completion, failure, approval, and input alerts when Synara is closed.</p>
              </div>
            </div>

            {!notifications ? <LoadingBlock label="Checking notification support" /> : null}
            {notifications?.subscribed ? (
              <p className="onboarding-complete">
                <IconCheck aria-hidden="true" size={16} /> Notifications enabled
              </p>
            ) : null}
            {requiresIosInstall ? (
              <p className="onboarding-guidance">
                Complete step 1 and reopen the Home Screen app to enable notifications.
              </p>
            ) : null}
            {notifications && !notifications.supported && !requiresIosInstall ? (
              <p className="onboarding-guidance">
                Notifications are unavailable here. Confirm you are using Synara over private
                Tailnet HTTPS, then check browser notification settings.
              </p>
            ) : null}
            {notifications?.supported && !notifications.subscribed && !requiresIosInstall ? (
              <>
                <div className="privacy-warning">
                  <IconMessage aria-hidden="true" size={18} />
                  Message previews may appear on your lock screen and pass through your device's
                  push service. You can disable previews later in Settings.
                </div>
                <button
                  type="button"
                  className="button button--primary button--wide"
                  disabled={busy !== null || notifications.permission === "denied"}
                  onClick={() => void enableNotifications()}
                >
                  <IconBellCheck aria-hidden="true" size={18} />
                  {busy === "notifications"
                    ? "Requesting permission..."
                    : notifications.permission === "denied"
                      ? "Blocked in browser settings"
                      : "Enable notifications"}
                </button>
              </>
            ) : null}
          </div>
        </li>
      </ol>

      <button type="button" className="button button--primary button--wide" onClick={finish}>
        Continue to Synara
        <IconArrowRight aria-hidden="true" size={19} />
      </button>
      <p className="onboarding-later">You can finish either step later from Settings.</p>
    </div>
  );
}
