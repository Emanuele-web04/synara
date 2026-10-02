// FILE: EnvironmentUsageSection.browser.tsx
// Purpose: Browser coverage for provider-account usage rows and multi-window summaries.

import "../../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const appSettingsMocks = vi.hoisted(() => ({
  useAppSettings: vi.fn(() => ({ settings: { codexHomePath: "" } })),
}));

vi.mock("~/appSettings", () => ({
  useAppSettings: appSettingsMocks.useAppSettings,
}));

import { serverQueryKeys } from "~/lib/serverReactQuery";

import { EnvironmentUsageSection } from "./EnvironmentUsageSection";

function snapshot(
  provider: ServerProviderUsageSnapshot["provider"],
  limits: ServerProviderUsageSnapshot["limits"],
  usageLines: ServerProviderUsageSnapshot["usageLines"] = [],
): ServerProviderUsageSnapshot {
  return {
    provider,
    updatedAt: "2026-08-30T12:00:00.000Z",
    limits,
    usageLines,
    source: "test",
    status: "ok",
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
}

describe("EnvironmentUsageSection", () => {
  it("keeps a named default account visible when its login expires", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      {
        ...snapshot("codex", []),
        instanceId: "codex",
        status: "needs-auth",
        detail: "Sign in to Personal.",
      },
      {
        ...snapshot("codex", [{ window: "Weekly", usedPercent: 60, windowDurationMins: 10_080 }]),
        instanceId: "codex_work",
      },
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: {
        codex: { driver: "codex", displayName: "Personal" },
        codex_work: { driver: "codex", displayName: "Work" },
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="codex" />
      </QueryClientProvider>,
    );

    const personal = page.getByRole("button", { name: "Codex · Personal usage: Sign in" });
    await expect.element(personal).toBeVisible();
    await personal.click();
    await expect.element(page.getByText("Sign in to Personal.", { exact: true })).toBeVisible();
    expect(page.getByText("40% left", { exact: true }).query()).toBeNull();
  });

  it("renders all providers with every reported usage window", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [
        { window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 },
        { window: "5h", usedPercent: 5, windowDurationMins: 300 },
      ]),
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54, windowDurationMins: 10_080 }]),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="codex" />
      </QueryClientProvider>,
    );

    const codex = page.getByRole("button", {
      name: "Codex usage: 5h 95% remaining, Weekly 82% remaining",
    });
    await expect.element(codex).toBeVisible();
    await expect
      .element(
        page.getByRole("button", {
          name: "Claude usage: Weekly 46% remaining",
        }),
      )
      .toBeVisible();
    await expect.element(page.getByText("5h", { exact: true })).toBeVisible();
    await expect.element(codex.getByText("Weekly", { exact: true })).toBeVisible();

    await codex.click();

    await expect.element(page.getByText("95% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();
  });

  it("hides the section while no provider has anything displayable", async () => {
    const queryClient = createQueryClient();
    // Batch resolved but the provider's live fetch was dropped (e.g. errored server-side) and no
    // local/thread fallback produced rows: nothing renders until some source yields data.
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="claudeAgent" />
      </QueryClientProvider>,
    );

    expect(document.querySelector('button[aria-label^="Claude usage:"]')).toBeNull();
    expect(document.querySelector('button[aria-label^="Codex usage:"]')).toBeNull();
  });

  it("shows both named accounts and opens each account's own usage", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      {
        ...snapshot("codex", [{ window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 }]),
        instanceId: "codex",
      },
      {
        ...snapshot("codex", [{ window: "Weekly", usedPercent: 60, windowDurationMins: 10_080 }]),
        instanceId: "codex_work",
      },
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: {
        codex: { driver: "codex", displayName: "Personal" },
        codex_work: { driver: "codex", displayName: "Work" },
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="codex" />
      </QueryClientProvider>,
    );

    await expect
      .element(
        page.getByRole("button", {
          name: "Codex · Personal usage: Weekly 82% remaining",
        }),
      )
      .toBeVisible();
    const work = page.getByRole("button", {
      name: "Codex · Work usage: Weekly 40% remaining",
    });
    await expect.element(work).toBeVisible();
    await work.click();
    await expect.element(page.getByText("40% left", { exact: true })).toBeVisible();
    expect(page.getByText("82% left", { exact: true }).query()).toBeNull();
  });

  it("keeps an enabled sibling visible when the default account is disabled", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      {
        ...snapshot("codex", [{ window: "Weekly", usedPercent: 60, windowDurationMins: 10_080 }]),
        instanceId: "codex_work",
      },
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providers: {
        ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS_VIEW.providers.codex, enabled: false },
      },
      providerInstances: { codex_work: { driver: "codex", displayName: "Work", enabled: true } },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="codex" />
      </QueryClientProvider>,
    );

    await expect
      .element(
        page.getByRole("button", {
          name: "Codex · Work usage: Weekly 40% remaining",
        }),
      )
      .toBeVisible();
  });

  it("shows an expired additional account without borrowing another account's usage", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      {
        ...snapshot("codex", [{ window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 }]),
        instanceId: "codex",
      },
      {
        ...snapshot("codex", []),
        instanceId: "codex_work",
        status: "needs-auth",
        detail: "Sign in to Work.",
      },
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: { codex_work: { driver: "codex", displayName: "Work" } },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="codex" />
      </QueryClientProvider>,
    );

    const work = page.getByRole("button", { name: "Codex · Work usage: Sign in" });
    await expect.element(work).toBeVisible();
    await work.click();
    await expect.element(page.getByText("Sign in to Work.", { exact: true })).toBeVisible();
    expect(page.getByText("82% left", { exact: true }).query()).toBeNull();
  });

  it("shows the row from usage lines alone when the provider reports no limit windows", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot(
        "droid",
        [],
        [{ label: "Limits", value: "Remaining limits stay in the Droid CLI." }],
      ),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="droid" />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("button", { name: "Droid usage: Connected" }))
      .toBeVisible();
  });

  it("hides the section when the active provider is disabled", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("cursor", [{ window: "Current", usedPercent: 30 }]),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providers: {
        ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
        cursor: { ...DEFAULT_SERVER_SETTINGS_VIEW.providers.cursor, enabled: false },
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="cursor" />
      </QueryClientProvider>,
    );

    expect(document.querySelector('button[aria-label^="Cursor usage:"]')).toBeNull();
  });
});
