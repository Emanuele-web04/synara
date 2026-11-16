import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppSettingsSchema } from "~/appSettings";
import { buildNotificationSettingsSupportText } from "~/notifications/taskCompletion";

import {
  desktopNotificationsUnavailableToast,
  NotificationsSettingsPanel,
  resolveSystemNotificationEnableResult,
  resolveTestNotificationToast,
} from "./DesktopSettingsPanels";

const SETTINGS = AppSettingsSchema.makeUnsafe({});

describe("buildNotificationSettingsSupportText", () => {
  it("explains each browser permission state", () => {
    expect(buildNotificationSettingsSupportText("granted")).toBe(
      "Browser notifications are enabled for this app.",
    );
    expect(buildNotificationSettingsSupportText("denied")).toBe(
      "Browser notifications are blocked. Re-enable them in your browser site settings.",
    );
    expect(buildNotificationSettingsSupportText("insecure")).toBe(
      "Browser notifications need a secure context. Localhost works; plain HTTP does not.",
    );
    expect(buildNotificationSettingsSupportText("unsupported")).toBe(
      "This browser does not support desktop notifications.",
    );
    expect(buildNotificationSettingsSupportText("default")).toContain(
      "Allow browser notifications",
    );
  });
});

describe("resolveSystemNotificationEnableResult", () => {
  it("enables when permission is granted", () => {
    expect(resolveSystemNotificationEnableResult("granted")).toEqual({ enable: true });
  });

  it("warns instead of erroring when the user blocked notifications", () => {
    const result = resolveSystemNotificationEnableResult("denied");

    expect(result.enable).toBe(false);
    if (result.enable) return;
    expect(result.toast.type).toBe("warning");
    expect(result.toast.title).toBe("Desktop notifications unavailable");
  });

  it("errors for states the user cannot fix in-place", () => {
    for (const permission of ["insecure", "unsupported"] as const) {
      const result = resolveSystemNotificationEnableResult(permission);

      expect(result.enable).toBe(false);
      if (result.enable) continue;
      expect(result.toast.type).toBe("error");
    }
  });

  it("blocks with an error when the permission request is dismissed", () => {
    const result = resolveSystemNotificationEnableResult("default");

    expect(result.enable).toBe(false);
  });
});

describe("resolveTestNotificationToast", () => {
  it("allows the test when permission is granted", () => {
    expect(resolveTestNotificationToast("granted")).toBeNull();
  });

  it("blocks the test with a warning for denied permission", () => {
    expect(resolveTestNotificationToast("denied")).toMatchObject({
      type: "warning",
      title: "Desktop notifications unavailable",
    });
  });

  it("blocks the test with an error for insecure and unsupported contexts", () => {
    expect(resolveTestNotificationToast("insecure")).toMatchObject({ type: "error" });
    expect(resolveTestNotificationToast("unsupported")).toMatchObject({ type: "error" });
  });
});

describe("desktopNotificationsUnavailableToast", () => {
  it("carries the permission-specific support text", () => {
    expect(desktopNotificationsUnavailableToast("insecure").description).toContain(
      "secure context",
    );
    expect(desktopNotificationsUnavailableToast("denied").description).toContain("blocked");
  });
});

describe("NotificationsSettingsPanel", () => {
  function renderPanel(active = true) {
    return renderToStaticMarkup(
      <NotificationsSettingsPanel
        settings={SETTINGS}
        defaults={SETTINGS}
        updateSettings={() => undefined}
        active={active}
      />,
    );
  }

  it("renders nothing when the section is not active", () => {
    expect(renderPanel(false)).toBe("");
  });

  it("renders the intro card and alert rows", () => {
    const html = renderPanel();

    expect(html).toContain("Get notified when work finishes or waits on you");
    expect(html).toContain("Activity toasts");
    expect(html).toContain("Desktop notifications");
    expect(html).toContain("Wait for subagents");
  });
});
