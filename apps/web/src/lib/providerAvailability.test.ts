import { describe, expect, it } from "vitest";

import type { ServerProviderStatus } from "@t3tools/contracts";
import {
  isProviderUsable,
  normalizeProviderStatusForLocalConfig,
  providerUnavailableReason,
} from "./providerAvailability";

const BASE_STATUS: ServerProviderStatus = {
  provider: "gemini",
  status: "error",
  available: false,
  authStatus: "unknown",
  checkedAt: "2026-04-17T10:00:00.000Z",
  message: "Gemini CLI (`gemini`) is not installed or not on PATH.",
};

describe("normalizeProviderStatusForLocalConfig", () => {
  it("keeps Gemini interactive when a custom binary path is configured locally", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "gemini",
        status: BASE_STATUS,
        customBinaryPath: "/opt/homebrew/bin/gemini",
      }),
    ).toEqual({
      ...BASE_STATUS,
      available: true,
      status: "warning",
      message:
        "Gemini uses a custom local binary path in this app. Availability will be confirmed when you start a session.",
    });
  });

  it("applies the same custom-path fallback to Claude", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "claudeAgent",
        status: {
          ...BASE_STATUS,
          provider: "claudeAgent",
          message: "Claude Code CLI (`claude`) is not installed or not on PATH.",
        },
        customBinaryPath: "/opt/homebrew/bin/claude",
      }),
    ).toEqual({
      ...BASE_STATUS,
      provider: "claudeAgent",
      available: true,
      status: "warning",
      message:
        "Claude uses a custom local binary path in this app. Availability will be confirmed when you start a session.",
    });
  });

  it("marks a custom-path provider ready after a successful session confirms it", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "opencode",
        status: {
          ...BASE_STATUS,
          provider: "opencode",
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        },
        customBinaryPath: "/custom/bin/opencode",
        confirmedCustomBinaryPath: "/custom/bin/opencode",
      }),
    ).toEqual({
      provider: "opencode",
      authStatus: "unknown",
      available: true,
      checkedAt: BASE_STATUS.checkedAt,
      status: "ready",
    });
  });

  it("keeps warning when a different custom path was confirmed", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "opencode",
        status: {
          ...BASE_STATUS,
          provider: "opencode",
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        },
        customBinaryPath: "/custom/bin/opencode-next",
        confirmedCustomBinaryPath: "/custom/bin/opencode",
      }),
    ).toEqual({
      ...BASE_STATUS,
      provider: "opencode",
      available: true,
      status: "warning",
      message:
        "OpenCode uses a custom local binary path in this app. Availability will be confirmed when you start a session.",
    });
  });

  it("preserves authenticated and unauthenticated statuses", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "gemini",
        status: { ...BASE_STATUS, available: true, status: "ready", authStatus: "authenticated" },
        customBinaryPath: "/opt/homebrew/bin/gemini",
      }),
    ).toEqual({ ...BASE_STATUS, available: true, status: "ready", authStatus: "authenticated" });

    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "gemini",
        status: { ...BASE_STATUS, authStatus: "unauthenticated" },
        customBinaryPath: "/opt/homebrew/bin/gemini",
      }),
    ).toEqual({ ...BASE_STATUS, authStatus: "unauthenticated" });
  });
});

describe("isProviderUsable", () => {
  it("blocks unavailable or unauthenticated providers", () => {
    expect(isProviderUsable(BASE_STATUS)).toBe(false);
    expect(
      isProviderUsable({ ...BASE_STATUS, available: true, authStatus: "unauthenticated" }),
    ).toBe(false);
    expect(isProviderUsable({ ...BASE_STATUS, available: true, authStatus: "authenticated" })).toBe(
      true,
    );
  });
});

describe("providerUnavailableReason", () => {
  it("returns provider-specific guidance", () => {
    expect(providerUnavailableReason({ ...BASE_STATUS, authStatus: "unauthenticated" })).toBe(
      "Gemini is not authenticated yet.",
    );
    expect(providerUnavailableReason(BASE_STATUS)).toBe(BASE_STATUS.message);
  });
});
