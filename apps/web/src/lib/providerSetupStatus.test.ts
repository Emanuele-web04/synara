import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { providerSetupStatusLabel } from "./providerSetupStatus";

const connected: ServerProviderStatus = {
  provider: "opencode",
  available: true,
  status: "ready",
  authStatus: "authenticated",
  checkedAt: "2026-09-16T21:46:18.000Z",
};

describe("providerSetupStatusLabel", () => {
  it.each([
    [undefined, false, false, "Checking setup"],
    [connected, false, false, "Checking setup"],
    [connected, true, true, "Disabled · enable to check setup"],
    [undefined, false, true, "Disabled · enable to check setup"],
    [{ ...connected, available: false, authStatus: "unknown" }, true, false, "Unavailable"],
    [{ ...connected, available: false, status: "error" }, true, false, "Unavailable"],
    [{ ...connected, authStatus: "unauthenticated" }, true, false, "Needs sign-in"],
    [{ ...connected, authStatus: "unknown" }, true, false, "Installed · sign-in not verified"],
    [{ ...connected, status: "warning" }, true, false, "Needs attention"],
    [{ ...connected, status: "error" }, true, false, "Needs attention"],
    [connected, true, false, "Connected"],
  ] as const)(
    "classifies setup without treating enablement as connection: %s",
    (status, reconciled, disabled, expected) => {
      expect(providerSetupStatusLabel({ status, reconciled, disabled })).toBe(expected);
    },
  );
});
