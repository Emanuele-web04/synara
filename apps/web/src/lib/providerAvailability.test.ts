import { describe, expect, it, vi } from "vitest";

import type { ServerProviderStatus } from "@synara/contracts";
import {
  findProviderStatus,
  isProviderUsable,
  normalizeProviderStatusForLocalConfig,
  providerUnavailableReason,
  resolveProviderSendAvailability,
  resolveProviderSendAvailabilityWithRefresh,
  resolveVoiceTranscriptionTarget,
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

const READY_STATUS: ServerProviderStatus = {
  ...BASE_STATUS,
  available: true,
  status: "ready",
  authStatus: "authenticated",
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

  it("does not use custom binary fallback for disabled provider instances", () => {
    const disabledStatus: ServerProviderStatus = {
      ...BASE_STATUS,
      instanceId: "gemini_work",
      displayName: "Gemini Work",
      enabled: false,
      message: "Provider is disabled in Synara settings.",
    };

    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "gemini",
        status: disabledStatus,
        customBinaryPath: "/opt/homebrew/bin/gemini",
      }),
    ).toEqual(disabledStatus);
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

describe("resolveVoiceTranscriptionTarget", () => {
  const codexStatus = (
    instanceId: string,
    voiceTranscriptionAvailable: boolean | undefined,
  ): ServerProviderStatus => ({
    ...READY_STATUS,
    provider: "codex",
    driver: "codex",
    instanceId,
    displayName: instanceId,
    ...(voiceTranscriptionAvailable === undefined ? {} : { voiceTranscriptionAvailable }),
  });
  const providerInstances = [
    {
      instanceId: "codex" as const,
      provider: "codex" as const,
      enabled: true,
      isDefault: true,
    },
    {
      instanceId: "codex_work" as const,
      provider: "codex" as const,
      enabled: true,
      isDefault: false,
    },
  ];

  it("uses a capable selected Codex account", () => {
    expect(
      resolveVoiceTranscriptionTarget({
        statuses: [codexStatus("codex", true), codexStatus("codex_work", true)],
        providerInstances,
        selectedProvider: "codex",
        selectedProviderInstanceId: "codex_work",
      })?.instanceId,
    ).toBe("codex_work");
  });

  it("uses a secondary capable Codex account when the default cannot transcribe", () => {
    expect(
      resolveVoiceTranscriptionTarget({
        statuses: [codexStatus("codex", false), codexStatus("codex_work", true)],
        providerInstances,
        selectedProvider: "gemini",
        selectedProviderInstanceId: "gemini",
      })?.instanceId,
    ).toBe("codex_work");
  });

  it("chooses secondary accounts deterministically regardless of status arrival order", () => {
    const instances = [
      ...providerInstances,
      {
        instanceId: "codex_alpha" as const,
        provider: "codex" as const,
        enabled: true,
        isDefault: false,
      },
    ];
    const statuses = [
      codexStatus("codex_work", true),
      codexStatus("codex_alpha", true),
      codexStatus("codex", false),
    ];

    expect(
      resolveVoiceTranscriptionTarget({
        statuses,
        providerInstances: instances,
        selectedProvider: "grok",
        selectedProviderInstanceId: "grok",
      })?.instanceId,
    ).toBe("codex_alpha");
    expect(
      resolveVoiceTranscriptionTarget({
        statuses: [...statuses].reverse(),
        providerInstances: [...instances].reverse(),
        selectedProvider: "grok",
        selectedProviderInstanceId: "grok",
      })?.instanceId,
    ).toBe("codex_alpha");
  });

  it("ignores a removed selected account even when its stale status advertises voice", () => {
    expect(
      resolveVoiceTranscriptionTarget({
        statuses: [codexStatus("codex", true), codexStatus("codex_removed", true)],
        providerInstances,
        selectedProvider: "codex",
        selectedProviderInstanceId: "codex_removed",
      })?.instanceId,
    ).toBe("codex");
  });

  it("returns no target when all configured Codex instances are disabled", () => {
    expect(
      resolveVoiceTranscriptionTarget({
        statuses: [codexStatus("codex", true), codexStatus("codex_work", true)],
        providerInstances: providerInstances.map((instance) => ({ ...instance, enabled: false })),
        selectedProvider: "codex",
        selectedProviderInstanceId: "codex_work",
      }),
    ).toBeNull();
  });

  it("does not resurrect a status-only stale Codex instance", () => {
    expect(
      resolveVoiceTranscriptionTarget({
        statuses: [codexStatus("codex_removed", true)],
        providerInstances: [],
        selectedProvider: "gemini",
        selectedProviderInstanceId: "gemini",
      }),
    ).toBeNull();
  });

  it("does not fall back to an unavailable configured instance", () => {
    expect(
      resolveVoiceTranscriptionTarget({
        statuses: [{ ...codexStatus("codex", true), available: false }],
        providerInstances: providerInstances.slice(0, 1),
        selectedProvider: "gemini",
        selectedProviderInstanceId: "gemini",
      }),
    ).toBeNull();
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
    // Advisory warnings the health layer marks available (Pi bundled SDK,
    // Cursor model-discovery warnings) stay sendable.
    expect(
      isProviderUsable({
        ...BASE_STATUS,
        available: true,
        status: "warning",
        authStatus: "authenticated",
      }),
    ).toBe(true);
    expect(
      isProviderUsable({
        ...BASE_STATUS,
        available: true,
        status: "ready",
        authStatus: "authenticated",
      }),
    ).toBe(true);
  });

  it("blocks disabled providers even when their stale health status is ready", () => {
    expect(
      isProviderUsable({
        ...READY_STATUS,
        enabled: false,
      }),
    ).toBe(false);
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

describe("resolveProviderSendAvailabilityWithRefresh", () => {
  it("returns usable providers without refreshing", async () => {
    const refreshStatuses = vi.fn(async () => null);

    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "gemini",
        statuses: [READY_STATUS],
        refreshStatuses,
      }),
    ).resolves.toMatchObject({ usable: true });
    expect(refreshStatuses).not.toHaveBeenCalled();
  });

  it("rechecks missing provider status before showing the loading block", async () => {
    const refreshStatuses = vi.fn(async () => [READY_STATUS]);

    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "gemini",
        statuses: [],
        refreshStatuses,
      }),
    ).resolves.toMatchObject({ usable: true });
    expect(refreshStatuses).toHaveBeenCalledTimes(1);
  });

  it("rechecks stale unauthenticated status before blocking send", async () => {
    const refreshStatuses = vi.fn(async () => [READY_STATUS]);

    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "gemini",
        statuses: [
          { ...BASE_STATUS, available: true, status: "error", authStatus: "unauthenticated" },
        ],
        refreshStatuses,
      }),
    ).resolves.toMatchObject({ usable: true });
    expect(refreshStatuses).toHaveBeenCalledTimes(1);
  });

  it("keeps the original blocked reason when refresh fails", async () => {
    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "gemini",
        statuses: [{ ...BASE_STATUS, authStatus: "unauthenticated" }],
        refreshStatuses: vi.fn(async () => {
          throw new Error("refresh failed");
        }),
      }),
    ).resolves.toMatchObject({
      usable: false,
      unavailableReason: "Gemini is not authenticated yet.",
    });
  });

  it("keeps resolving the selected instance after a refresh", async () => {
    const readyWorkInstance: ServerProviderStatus = {
      ...READY_STATUS,
      instanceId: "gemini_work",
    };
    const blockedDefaultInstance: ServerProviderStatus = {
      ...BASE_STATUS,
      authStatus: "unauthenticated",
      available: true,
    };
    const refreshStatuses = vi.fn(async () => [blockedDefaultInstance, readyWorkInstance]);

    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "gemini",
        instanceId: "gemini_work",
        statuses: [blockedDefaultInstance],
        refreshStatuses,
      }),
    ).resolves.toMatchObject({
      usable: true,
      status: { instanceId: "gemini_work" },
    });
    expect(refreshStatuses).toHaveBeenCalledTimes(1);
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
  it("uses the provider default identity when no instance id is supplied", () => {
    const workStatus: ServerProviderStatus = {
      ...READY_STATUS,
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "claude_work",
      displayName: "Work",
    };
    const defaultStatus: ServerProviderStatus = {
      ...BASE_STATUS,
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      displayName: "Claude",
    };

    expect(findProviderStatus([workStatus, defaultStatus], "claudeAgent")).toEqual(defaultStatus);
    expect(
      resolveProviderSendAvailability({
        provider: "claudeAgent",
        statuses: [workStatus, defaultStatus],
      }),
    ).toMatchObject({
      usable: false,
      status: { instanceId: "claudeAgent" },
    });
  });

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
