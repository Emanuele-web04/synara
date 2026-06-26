import { describe, expect, it } from "vitest";

import type { ServerProviderStatus } from "@t3tools/contracts";
import {
  findProviderStatus,
  isProviderUsable,
  normalizeProviderStatusForLocalConfig,
  providerUnavailableReason,
  resolveProviderSendAvailability,
} from "./providerAvailability";

const BASE_STATUS: ServerProviderStatus = {
  provider: "gemini",
  instanceId: "gemini",
  driver: "gemini",
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
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          message: "Claude Code CLI (`claude`) is not installed or not on PATH.",
        },
        customBinaryPath: "/opt/homebrew/bin/claude",
      }),
    ).toEqual({
      ...BASE_STATUS,
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      driver: "claudeAgent",
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
          instanceId: "opencode",
          driver: "opencode",
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        },
        customBinaryPath: "/custom/bin/opencode",
        confirmedCustomBinaryPath: "/custom/bin/opencode",
      }),
    ).toEqual({
      provider: "opencode",
      instanceId: "opencode",
      driver: "opencode",
      authStatus: "unknown",
      available: true,
      checkedAt: BASE_STATUS.checkedAt,
      status: "ready",
    });
  });

  it("preserves provider instance metadata when a confirmed custom path becomes ready", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "claudeAgent",
        status: {
          ...BASE_STATUS,
          provider: "claudeAgent",
          driver: "claudeAgent",
          instanceId: "claude_work",
          displayName: "Claude Work",
          message: "Claude Code CLI (`claude`) is not installed or not on PATH.",
        },
        customBinaryPath: "/custom/bin/claude",
        confirmedCustomBinaryPath: "/custom/bin/claude",
      }),
    ).toEqual({
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "claude_work",
      displayName: "Claude Work",
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
          instanceId: "opencode",
          driver: "opencode",
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        },
        customBinaryPath: "/custom/bin/opencode-next",
        confirmedCustomBinaryPath: "/custom/bin/opencode",
      }),
    ).toEqual({
      ...BASE_STATUS,
      provider: "opencode",
      instanceId: "opencode",
      driver: "opencode",
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
    expect(isProviderUsable(null)).toBe(false);
    expect(isProviderUsable(undefined)).toBe(false);
    expect(isProviderUsable(BASE_STATUS)).toBe(false);
    expect(
      isProviderUsable({ ...BASE_STATUS, available: true, authStatus: "unauthenticated" }),
    ).toBe(false);
    expect(
      isProviderUsable({
        ...BASE_STATUS,
        available: true,
        status: "warning",
        authStatus: "authenticated",
      }),
    ).toBe(false);
    expect(
      isProviderUsable({
        ...BASE_STATUS,
        available: true,
        status: "ready",
        authStatus: "authenticated",
      }),
    ).toBe(true);
  });

  it("allows the local custom-binary confirmation fallback to start a session", () => {
    const normalized = normalizeProviderStatusForLocalConfig({
      provider: "gemini",
      status: BASE_STATUS,
      customBinaryPath: "/opt/homebrew/bin/gemini",
    });

    expect(normalized?.status).toBe("warning");
    expect(isProviderUsable(normalized)).toBe(true);
    expect(
      resolveProviderSendAvailability({ provider: "gemini", statuses: [normalized!] }),
    ).toMatchObject({
      usable: true,
    });
  });
});

describe("providerUnavailableReason", () => {
  it("returns provider-specific guidance", () => {
    expect(providerUnavailableReason({ ...BASE_STATUS, authStatus: "unauthenticated" })).toBe(
      "Gemini is not authenticated yet.",
    );
    expect(providerUnavailableReason(BASE_STATUS)).toBe(BASE_STATUS.message);
  });

  it("uses provider instance display names when available", () => {
    expect(
      providerUnavailableReason({
        ...BASE_STATUS,
        provider: "claudeAgent",
        instanceId: "claude_work",
        driver: "claudeAgent",
        displayName: "Claude Work",
        authStatus: "unauthenticated",
      }),
    ).toBe("Claude Work is not authenticated yet.");
  });
});

describe("findProviderStatus", () => {
  it("selects the exact provider instance when multiple instances share a provider", () => {
    const statuses: ServerProviderStatus[] = [
      {
        ...BASE_STATUS,
        provider: "claudeAgent",
        instanceId: "claude",
        driver: "claudeAgent",
        displayName: "Claude",
        status: "ready",
        available: true,
        authStatus: "authenticated",
      },
      {
        ...BASE_STATUS,
        provider: "claudeAgent",
        instanceId: "claude_work",
        driver: "claudeAgent",
        displayName: "Work",
        message: "Work account is disabled.",
      },
    ];

    expect(findProviderStatus(statuses, "claudeAgent", "claude_work")).toEqual(statuses[1]);
    expect(
      resolveProviderSendAvailability({
        provider: "claudeAgent",
        instanceId: "claude_work",
        statuses,
      }),
    ).toMatchObject({
      usable: false,
      unavailableReason: "Work account is disabled.",
    });
  });

  it("does not fall back to the default provider status when an explicit instance is missing", () => {
    const statuses: ServerProviderStatus[] = [
      {
        ...BASE_STATUS,
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude",
        status: "ready",
        available: true,
        authStatus: "authenticated",
      },
    ];

    expect(findProviderStatus(statuses, "claudeAgent", "claude_work")).toBeNull();
    expect(
      resolveProviderSendAvailability({
        provider: "claudeAgent",
        instanceId: "claude_work",
        statuses,
      }),
    ).toMatchObject({
      usable: false,
      unavailableReason: "Provider status is still loading.",
    });
  });
});
