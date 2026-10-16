import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ServerProviderUsageSnapshot,
  type ServerSettingsView,
} from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { describe, expect, it } from "vitest";

import {
  resolveEnvironmentProviderUsageSummary,
  selectEnvironmentUsageAccounts,
} from "./EnvironmentUsageSection.logic";

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    updatedAt: "2026-10-09T12:00:00.000Z",
    limits: [{ window: "Weekly", usedPercent: 20 }],
    usageLines: [],
    source: "test",
    status: "ok",
    ...input,
  };
}

function accounts(
  snapshots: ReadonlyArray<ServerProviderUsageSnapshot>,
  settings: ServerSettingsView = DEFAULT_SERVER_SETTINGS_VIEW,
) {
  return selectEnvironmentUsageAccounts({
    instances: deriveProviderInstances(settings),
    snapshots,
  });
}

describe("selectEnvironmentUsageAccounts", () => {
  it("keeps every enabled provider without treating unrelated drivers as sibling accounts", () => {
    expect(
      accounts([snapshot(), snapshot({ provider: "claudeAgent" })]).map(({ label }) => label),
    ).toEqual(["Codex", "Claude"]);
  });

  it("qualifies multiple accounts of one driver and preserves each snapshot's identity", () => {
    const personal = snapshot({ instanceId: "codex" });
    const work = snapshot({
      instanceId: "codex_work",
      limits: [{ window: "Weekly", usedPercent: 80 }],
    });
    const result = accounts([work, personal, snapshot({ provider: "claudeAgent" })], {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: { codex_work: { driver: "codex", displayName: "Work" } },
    });

    expect(result.map(({ label }) => label)).toEqual([
      "Codex · Default account",
      "Codex · Work",
      "Claude",
    ]);
    expect(result[0]?.snapshot).toBe(personal);
    expect(result[1]?.snapshot).toBe(work);
  });

  it("does not match a legacy default snapshot to an additional account", () => {
    expect(
      accounts([snapshot()], {
        ...DEFAULT_SERVER_SETTINGS_VIEW,
        providerInstances: { codex_work: { driver: "codex", displayName: "Work" } },
      }).map(({ instance }) => instance.instanceId),
    ).toEqual(["codex"]);
  });

  it("drops disabled, removed and retargeted account snapshots but keeps an enabled sibling", () => {
    const result = accounts(
      [
        snapshot({ instanceId: "codex" }),
        snapshot({ instanceId: "codex_work" }),
        snapshot({ instanceId: "codex_disabled" }),
        snapshot({ instanceId: "removed" }),
        snapshot({ instanceId: "retargeted" }),
      ],
      {
        ...DEFAULT_SERVER_SETTINGS_VIEW,
        providers: {
          ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
          codex: { ...DEFAULT_SERVER_SETTINGS_VIEW.providers.codex, enabled: false },
        },
        providerInstances: {
          codex_work: { driver: "codex", displayName: "Work", enabled: true },
          codex_disabled: { driver: "codex", enabled: false },
          retargeted: { driver: "claudeAgent" },
        },
      },
    );

    expect(result.map(({ label }) => label)).toEqual(["Codex · Work"]);
  });

  it("suppresses empty usage even for named accounts and windows with no percentage", () => {
    expect(
      accounts(
        [
          snapshot({ limits: [] }),
          snapshot({ instanceId: "codex_work", limits: [{ window: "Weekly" }] }),
        ],
        {
          ...DEFAULT_SERVER_SETTINGS_VIEW,
          providerInstances: { codex_work: { driver: "codex", displayName: "Work" } },
        },
      ),
    ).toEqual([]);
    expect(accounts([])).toEqual([]);
  });

  it("does not show unused signed-out defaults just because another provider has usage", () => {
    expect(
      accounts([
        snapshot({ limits: [], status: "needs-auth" }),
        snapshot({ provider: "claudeAgent" }),
      ]).map(({ label }) => label),
    ).toEqual(["Claude"]);
  });

  it("keeps named defaults and additional accounts visible when authentication expires", () => {
    const result = accounts(
      [
        snapshot({ limits: [], status: "needs-auth" }),
        snapshot({ instanceId: "codex_work", limits: [], status: "needs-auth" }),
      ],
      {
        ...DEFAULT_SERVER_SETTINGS_VIEW,
        providerInstances: {
          codex: { driver: "codex", displayName: "Personal" },
          codex_work: { driver: "codex", displayName: "Work" },
        },
      },
    );

    expect(result.map(({ label }) => label)).toEqual(["Codex · Personal", "Codex · Work"]);
  });

  it.each(["error", "unsupported"] as const)(
    "shows meaningful %s status without usage",
    (status) => {
      expect(accounts([snapshot({ limits: [], status })]).map(({ label }) => label)).toEqual([
        "Codex",
      ]);
    },
  );

  it("keeps usage-line-only and reset-credit-only snapshots", () => {
    expect(
      accounts([
        snapshot({ limits: [], resetCredits: { availableCount: 1 } }),
        snapshot({
          provider: "droid",
          limits: [],
          usageLines: [{ label: "Tokens", value: "123" }],
        }),
      ]).map(({ label }) => label),
    ).toEqual(["Codex", "Droid"]);
  });
});

describe("resolveEnvironmentProviderUsageSummary", () => {
  it.each([
    ["needs-auth", "Sign in"],
    ["unsupported", "Unsupported"],
    ["error", "Unavailable"],
  ] as const)("describes %s without implying the account is connected", (status, label) => {
    expect(
      resolveEnvironmentProviderUsageSummary({
        providerName: "Codex · Work",
        snapshot: snapshot({ status, limits: [] }),
        rows: [],
        hasUsageLines: false,
      }),
    ).toMatchObject({ statusLabel: label, ariaLabel: `Codex · Work usage: ${label}` });
  });

  it("describes available reset credits as connected rather than no data", () => {
    expect(
      resolveEnvironmentProviderUsageSummary({
        providerName: "Codex",
        snapshot: snapshot({ limits: [] }),
        rows: [],
        hasUsageLines: false,
        hasResetCredits: true,
      }).statusLabel,
    ).toBe("Connected");
  });
});
