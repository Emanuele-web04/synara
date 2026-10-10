import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { providerAccountStatusSummary, providerSetupStatusLabel } from "./providerSetupStatus";

const connected: ServerProviderStatus = {
  provider: "opencode",
  instanceId: "opencode",
  driver: "opencode",
  available: true,
  status: "ready",
  authStatus: "authenticated",
  checkedAt: "2026-09-16T21:46:18.000Z",
};

describe("providerSetupStatusLabel", () => {
  it.each([
    [undefined, false, false, "Checking setup"],
    [connected, true, true, "Disabled · enable to check setup"],
    [{ ...connected, available: false, authStatus: "unknown" }, true, false, "Unavailable"],
    [{ ...connected, available: false, status: "error" }, true, false, "Unavailable"],
    [{ ...connected, authStatus: "unauthenticated" }, true, false, "Needs sign-in"],
    [
      { ...connected, authStatus: "unknown" },
      true,
      false,
      "Installed · authentication managed by OpenCode",
    ],
    [
      { ...connected, provider: "codex", driver: "codex", authStatus: "unknown" },
      true,
      false,
      "Installed · sign-in not verified",
    ],
    [{ ...connected, status: "warning" }, true, false, "Needs attention"],
    [connected, true, false, "Connected"],
  ] as const)(
    "classifies setup without treating enablement as connection: %s",
    (status, reconciled, disabled, expected) => {
      expect(providerSetupStatusLabel({ status, reconciled, disabled })).toBe(expected);
    },
  );

  it("keeps installation-only OpenCode checks neutral for named accounts", () => {
    const status = { ...connected, instanceId: "opencode:work", authStatus: "unknown" as const };
    expect(providerSetupStatusLabel({ status, reconciled: true, disabled: false })).toBe(
      "Installed · authentication managed by OpenCode",
    );
  });
});

describe("providerAccountStatusSummary", () => {
  it.each([
    [undefined, true, "idle", "Checking account status"],
    [connected, false, "idle", "Disabled"],
    [{ ...connected, available: false, status: "error" }, true, "error", "Unavailable"],
    [{ ...connected, authStatus: "unauthenticated" }, true, "warning", "Not authenticated"],
    [{ ...connected, status: "error" }, true, "error", "Unavailable"],
    [{ ...connected, status: "warning" }, true, "warning", "Needs attention"],
    [connected, true, "ready", "Authenticated"],
    [{ ...connected, authLabel: "ChatGPT Pro" }, true, "ready", "Authenticated · ChatGPT Pro"],
    [{ ...connected, authType: "apiKey" }, true, "ready", "Authenticated · apiKey"],
    [{ ...connected, authStatus: "unknown" }, true, "ready", "Available"],
  ] as const)("titles an account row: %s enabled=%s", (status, enabled, tone, headline) => {
    expect(providerAccountStatusSummary({ status, enabled })).toMatchObject({ tone, headline });
  });

  it("lets the local switch win over a stale healthy status", () => {
    expect(providerAccountStatusSummary({ status: connected, enabled: false })).toEqual({
      tone: "idle",
      headline: "Disabled",
      detail: null,
    });
  });

  it("carries the server's diagnosis as the detail", () => {
    expect(
      providerAccountStatusSummary({
        status: { ...connected, authStatus: "unauthenticated", message: "Run codex login." },
        enabled: true,
      }).detail,
    ).toBe("Run codex login.");
  });
});
