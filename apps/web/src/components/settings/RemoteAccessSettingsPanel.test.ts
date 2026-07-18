import type { DesktopRemoteAccessStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  canPairRemoteAccessDevice,
  deriveRemoteAccessHealth,
  formatPairingCode,
  formatPairingCountdown,
} from "./RemoteAccessSettingsPanel.logic";

function status(
  patch: Partial<DesktopRemoteAccessStatus> = {},
): DesktopRemoteAccessStatus {
  return {
    settings: {
      version: 1,
      enabled: true,
      port: 3773,
      trustedOrigin: "https://host.example.ts.net",
      keepRunningOnClose: true,
      launchAtLogin: false,
      keepRunningNoticeShown: false,
    },
    backend: { running: true, port: 3773, loopbackUrl: "http://127.0.0.1:3773" },
    tailscale: {
      checkedAt: "2026-07-18T00:00:00.000Z",
      cliAvailable: true,
      executable: "tailscale",
      connectionState: "connected",
      backendState: "Running",
      dnsName: "host.example.ts.net",
      tailnetName: "example.ts.net",
      serveState: "matching",
      funnelEnabled: false,
      expectedProxyTarget: "http://127.0.0.1:3773",
      expectedServeCommand: "tailscale serve --bg http://127.0.0.1:3773",
      proxyTargets: ["http://127.0.0.1:3773"],
      discoveredOrigin: "https://host.example.ts.net",
      mobileUrl: "https://host.example.ts.net/mobile/",
      issue: null,
    },
    mobileUrl: "https://host.example.ts.net/mobile/",
    configurationIssue: null,
    ...patch,
  };
}

describe("RemoteAccessSettingsPanel helpers", () => {
  it("formats the 12-character fallback code into readable groups", () => {
    expect(formatPairingCode("abcd2345wxyz")).toBe("ABCD 2345 WXYZ");
  });

  it("formats and expires pairing countdowns", () => {
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    expect(formatPairingCountdown("2026-07-18T00:01:05.000Z", now)).toBe("1:05");
    expect(formatPairingCountdown("2026-07-17T23:59:59.000Z", now)).toBe("Expired");
  });

  it("reports a healthy private Serve route as ready", () => {
    expect(deriveRemoteAccessHealth(status())).toMatchObject({
      label: "Ready",
      variant: "success",
    });
    expect(canPairRemoteAccessDevice(status())).toBe(true);
  });

  it("makes Funnel detection override an otherwise healthy route", () => {
    const base = status();
    expect(
      deriveRemoteAccessHealth(
        status({ tailscale: base.tailscale ? { ...base.tailscale, funnelEnabled: true } : null }),
      ),
    ).toMatchObject({ label: "Action required", variant: "error" });
  });

  it("does not enable pairing until diagnostics verify the exact private root route", () => {
    expect(canPairRemoteAccessDevice(status({ tailscale: null }))).toBe(false);

    const base = status();
    expect(
      canPairRemoteAccessDevice(
        status({
          tailscale: base.tailscale
            ? { ...base.tailscale, serveState: "different-target" }
            : null,
        }),
      ),
    ).toBe(false);
    expect(
      canPairRemoteAccessDevice(
        status({ configurationIssue: "The saved origin no longer matches Tailscale." }),
      ),
    ).toBe(false);
  });
});
