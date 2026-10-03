import {
  DEFAULT_SERVER_SETTINGS,
  type ServerProviderUsageSnapshot,
  type ServerSettings,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";

vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({ settings: { railUsageProviders: [] }, updateSettings: vi.fn() }),
}));

function snapshot(input: Partial<ServerProviderUsageSnapshot>): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    updatedAt: "2026-10-01T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    status: "ok",
    ...input,
  };
}

function render(
  snapshots: readonly ServerProviderUsageSnapshot[],
  settings: ServerSettings | null = DEFAULT_SERVER_SETTINGS,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (settings) queryClient.setQueryData(serverQueryKeys.settings(), settings);
  queryClient.setQueryData(serverQueryKeys.allProviderUsage(), snapshots);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ProviderUsageSettingsPanel />
    </QueryClientProvider>,
  );
}

describe("ProviderUsageSettingsPanel", () => {
  it("keeps sidebar provider switches alongside account usage cards", () => {
    const markup = render([
      snapshot({
        instanceId: "codex",
        usageLines: [{ label: "Personal allowance", value: "7 credits" }],
      }),
    ]);

    expect(markup).toContain('role="switch"');
    expect(markup).toContain("Show Codex usage at the bottom of the sidebar");
    expect(markup).toContain("Show Claude usage at the bottom of the sidebar");
    expect(markup).toContain("Personal allowance");
  });

  it("hides a cached disabled default account while keeping its enabled sibling", () => {
    const markup = render(
      [
        snapshot({
          instanceId: "codex",
          usageLines: [{ label: "Disabled default allowance", value: "7 credits" }],
        }),
        snapshot({
          instanceId: "codex_work",
          usageLines: [{ label: "Company allowance", value: "31 credits" }],
        }),
      ],
      {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
        },
        providerInstances: { codex_work: { driver: "codex", displayName: "Work account" } },
      },
    );

    expect(markup).not.toContain("Disabled default allowance");
    expect(markup).toContain("Company allowance");
    expect(markup).toContain("Work account");
  });

  it("hides cached generic accounts that are disabled or have been removed", () => {
    const markup = render(
      [
        snapshot({
          instanceId: "codex",
          usageLines: [{ label: "Personal allowance", value: "7 credits" }],
        }),
        snapshot({
          provider: "claudeAgent",
          instanceId: "claude_work",
          usageLines: [{ label: "Disabled allowance", value: "19 credits" }],
        }),
        snapshot({
          provider: "claudeAgent",
          instanceId: "claude_removed",
          usageLines: [{ label: "Removed allowance", value: "31 credits" }],
        }),
      ],
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          claude_work: { driver: "claudeAgent", displayName: "Work", enabled: false },
        },
      },
    );

    expect(markup).toContain("Personal allowance");
    expect(markup).not.toContain("Disabled allowance");
    expect(markup).not.toContain("Removed allowance");
  });

  it("shows cached account usage while server settings are still loading", () => {
    const markup = render(
      [
        snapshot({
          provider: "claudeAgent",
          instanceId: "claude_work",
          usageLines: [{ label: "Company allowance", value: "31 credits" }],
        }),
      ],
      null,
    );

    expect(markup).toContain("claude_work");
    expect(markup).toContain("Company allowance");
  });

  it("hides a cached snapshot when the account id now belongs to a different provider", () => {
    const markup = render(
      [
        snapshot({
          instanceId: "work",
          usageLines: [{ label: "Previous provider allowance", value: "31 credits" }],
        }),
      ],
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { work: { driver: "claudeAgent", displayName: "Work" } },
      },
    );

    expect(markup).not.toContain("Previous provider allowance");
  });

  it("shows configured account labels and each account's own usage", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          accounts: [
            {
              id: "work",
              label: "Work account",
              homePath: "/profiles/codex-work",
              shadowHomePath: "",
            },
          ],
        },
      },
      providerInstances: {
        claude_work: { driver: "claudeAgent", displayName: "Research account" },
      },
    };
    const markup = render(
      [
        snapshot({
          provider: "claudeAgent",
          instanceId: "claude_work",
          usageLines: [{ label: "Research allowance", value: "19 credits" }],
        }),
        snapshot({
          instanceId: "codex",
          usageLines: [{ label: "Personal allowance", value: "7 credits" }],
        }),
        snapshot({
          instanceId: "codex_work",
          usageLines: [{ label: "Company allowance", value: "31 credits" }],
        }),
      ],
      settings,
    );

    expect(markup).toContain("Work account");
    expect(markup).toContain("Research account");
    expect(markup.indexOf("Work account")).toBeLessThan(markup.indexOf("Research account"));
    expect(markup.match(/Personal allowance/g)).toHaveLength(1);
    expect(markup.match(/Company allowance/g)).toHaveLength(1);
    expect(markup.match(/Research allowance/g)).toHaveLength(1);
    expect(markup).toContain("7 credits");
    expect(markup).toContain("31 credits");
    expect(markup).toContain("19 credits");
  });

  it("keeps the provider name for a legacy snapshot without an instance id", () => {
    const markup = render([
      snapshot({
        provider: "claudeAgent",
        usageLines: [{ label: "Legacy allowance", value: "5 credits" }],
      }),
    ]);

    expect(markup).toContain("Claude");
    expect(markup).toContain("Legacy allowance");
    expect(markup).toContain("5 credits");
  });
});
