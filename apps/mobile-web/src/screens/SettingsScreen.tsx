import {
  IconBell,
  IconBellCheck,
  IconCheck,
  IconDeviceMobile,
  IconDownload,
  IconExternalLink,
  IconInfoCircle,
  IconLogout,
  IconMessage,
  IconRefresh,
  IconShieldLock,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useCompanion } from "../companionContext";
import { InlineError, LoadingBlock, ScreenHeader, SectionHeading } from "../components/ui";
import type { NotificationSettings } from "../domain";
import {
  isCurrentDeviceIos,
  isCurrentDisplayStandalone,
  useInstallPrompt,
} from "../lib/install";

export function SettingsScreen() {
  const {
    session,
    updateDeviceLabel,
    getNotificationSettings,
    subscribeToNotifications,
    setNotificationPreview,
    sendTestNotification,
    logout,
  } = useCompanion();
  const [notifications, setNotifications] = useState<NotificationSettings | null>(null);
  const [deviceLabel, setDeviceLabel] = useState(session?.deviceLabel ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { installPrompt, clearInstallPrompt } = useInstallPrompt();
  const installed = isCurrentDisplayStandalone();
  const ios = isCurrentDeviceIos();

  useEffect(() => {
    setDeviceLabel(session?.deviceLabel ?? "");
  }, [session?.deviceLabel]);

  useEffect(() => {
    const controller = new AbortController();
    void getNotificationSettings()
      .then((settings) => {
        if (!controller.signal.aborted) setNotifications(settings);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setError(
            loadError instanceof Error ? loadError.message : "Notification settings are unavailable.",
          );
        }
      });
    return () => {
      controller.abort();
    };
  }, [getNotificationSettings]);

  async function enableNotifications() {
    setBusy("notifications");
    setError(null);
    setMessage(null);
    try {
      const next = await subscribeToNotifications(true);
      setNotifications(next);
      setMessage("Notifications are enabled for this device.");
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

  async function togglePreview(enabled: boolean) {
    if (!notifications) return;
    const previous = notifications;
    setNotifications({ ...notifications, previewEnabled: enabled });
    setError(null);
    try {
      await setNotificationPreview(enabled);
    } catch (previewError) {
      setNotifications(previous);
      setError(previewError instanceof Error ? previewError.message : "The setting was not saved.");
    }
  }

  async function testNotification() {
    setBusy("test");
    setError(null);
    setMessage(null);
    try {
      await sendTestNotification();
      setMessage("Test notification sent.");
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "The test notification failed.");
    } finally {
      setBusy(null);
    }
  }

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") clearInstallPrompt();
  }

  async function saveDeviceLabel() {
    const nextLabel = deviceLabel.trim();
    if (nextLabel.length < 2 || nextLabel.length > 80) return;
    setBusy("device-label");
    setError(null);
    setMessage(null);
    try {
      await updateDeviceLabel(nextLabel);
      setDeviceLabel(nextLabel);
      setMessage("Device name updated.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The device name was not saved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="screen settings-screen">
      <ScreenHeader eyebrow="This device" title="Settings" />
      {error ? <InlineError>{error}</InlineError> : null}
      {message ? <p className="success-message" role="status">{message}</p> : null}

      <section className="settings-section">
        <SectionHeading title="Notifications" />
        {!notifications ? <LoadingBlock label="Checking notification support" /> : null}
        {notifications && (!notifications.supported || (ios && !installed)) ? (
          <div className="setting-card">
            <IconInfoCircle aria-hidden="true" size={21} />
            <div>
              <strong>Notifications are unavailable</strong>
              <p>
                Use a secure Tailnet HTTPS address. On iPhone and iPad, install Synara on the
                Home Screen first.
              </p>
            </div>
          </div>
        ) : null}
        {notifications?.supported && !notifications.subscribed && (!ios || installed) ? (
          <div className="setting-card setting-card--stacked">
            <div className="setting-card__row">
              <IconBell aria-hidden="true" size={22} />
              <div>
                <strong>Stay updated in the background</strong>
                <p>Get task completion, failure, approval, and input alerts.</p>
              </div>
            </div>
            <div className="privacy-warning">
              <IconMessage aria-hidden="true" size={18} />
              Message previews may appear on your lock screen and pass through your device’s
              push service. You can turn previews off below.
            </div>
            <button
              type="button"
              className="button button--primary button--wide"
              disabled={busy !== null || notifications.permission === "denied"}
              onClick={() => void enableNotifications()}
            >
              <IconBellCheck aria-hidden="true" size={19} />
              {busy === "notifications"
                ? "Enabling…"
                : notifications.permission === "denied"
                  ? "Blocked in browser settings"
                  : "Enable notifications"}
            </button>
          </div>
        ) : null}
        {notifications?.subscribed ? (
          <div className="settings-list">
            <label className="setting-row">
              <span className="setting-row__icon">
                <IconMessage aria-hidden="true" size={19} />
              </span>
              <span>
                <strong>Message previews</strong>
                <small>Show up to 160 sanitized characters</small>
              </span>
              <input
                className="switch"
                type="checkbox"
                checked={notifications.previewEnabled}
                onChange={(event) => void togglePreview(event.target.checked)}
              />
            </label>
            <button
              type="button"
              className="setting-row"
              disabled={busy !== null}
              onClick={() => void testNotification()}
            >
              <span className="setting-row__icon">
                <IconRefresh aria-hidden="true" size={19} />
              </span>
              <span>
                <strong>{busy === "test" ? "Sending test…" : "Send test notification"}</strong>
                <small>Verify background delivery on this device</small>
              </span>
            </button>
          </div>
        ) : null}
      </section>

      <section className="settings-section">
        <SectionHeading title="Install" />
        <div className="setting-card">
          <IconDownload aria-hidden="true" size={22} />
          <div>
            <strong>{installed ? "Installed on this device" : "Add Synara to your Home Screen"}</strong>
            <p>
              {installed
                ? "Synara can open full-screen like an app."
                : ios
                  ? "In Safari, tap Share, then Add to Home Screen. iOS notifications require installation."
                  : "Install for a full-screen experience and reliable background notifications."}
            </p>
          </div>
          {!installed && installPrompt ? (
            <button type="button" className="button button--secondary" onClick={() => void install()}>
              Install
            </button>
          ) : null}
        </div>
      </section>

      <section className="settings-section">
        <SectionHeading title="Connection" />
        <div className="settings-list">
          <form
            className="setting-row setting-row--device-label"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDeviceLabel();
            }}
          >
            <span className="setting-row__icon">
              <IconDeviceMobile aria-hidden="true" size={19} />
            </span>
            <label className="device-label-field" htmlFor="settings-device-label">
              <strong>Device name</strong>
              <input
                id="settings-device-label"
                value={deviceLabel}
                onChange={(event) => setDeviceLabel(event.target.value.slice(0, 80))}
                minLength={2}
                maxLength={80}
                autoComplete="off"
                disabled={busy !== null}
                required
                aria-describedby="device-label-expiry"
              />
              <small id="device-label-expiry">
                Session expires {formatExpiry(session?.expiresAt)}
              </small>
            </label>
            <button
              type="submit"
              className="button button--secondary device-label-save"
              disabled={
                busy !== null ||
                deviceLabel.trim().length < 2 ||
                deviceLabel.trim() === session?.deviceLabel
              }
            >
              <IconCheck aria-hidden="true" size={17} />
              {busy === "device-label" ? "Saving..." : "Save"}
            </button>
          </form>
          <div className="setting-row">
            <span className="setting-row__icon">
              <IconShieldLock aria-hidden="true" size={19} />
            </span>
            <span>
              <strong>Companion access</strong>
              <small>No terminal, project management, or direct Git actions</small>
            </span>
          </div>
          <button
            type="button"
            className="setting-row setting-row--danger"
            onClick={() => {
              if (window.confirm("Sign out this device from Synara?")) void logout();
            }}
          >
            <span className="setting-row__icon">
              <IconLogout aria-hidden="true" size={19} />
            </span>
            <span>
              <strong>Sign out this device</strong>
              <small>The desktop owner can also revoke this session</small>
            </span>
            <IconExternalLink aria-hidden="true" size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

function formatExpiry(value: string | undefined): string {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
