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
  it("reads usage hubs only for providers that hubs pool", async () => {
    const listUsageHubs = vi.fn(async () => []);
    vi.stubGlobal("nativeApi", { server: { listUsageHubs } });
    try {
      for (const provider of ["cursor", "claudeAgent"] as const) {
        const queryClient = createQueryClient();
        queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
        queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
        const screen = await render(
          <QueryClientProvider client={queryClient}>
            <EnvironmentUsageSection provider={provider} />
          </QueryClientProvider>,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await screen.unmount();
      }
      expect(listUsageHubs).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists the active provider's hub accounts after the local ones", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      {
        ...snapshot("claudeAgent", [{ window: "5h", usedPercent: 10, windowDurationMins: 300 }]),
        instanceId: "claudeAgent",
      },
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
    const hubAccount = (
      key: string,
      email: string,
      provider: "claudeAgent" | "codex",
      fiveHour: number,
      weekly: number,
    ) => ({
      id: `${email}.json`,
      key,
      email,
      usage: {
        ...snapshot(provider, [
          { window: "5h", usedPercent: fiveHour, windowDurationMins: 300 },
          { window: "Weekly", usedPercent: weekly, windowDurationMins: 10_080 },
        ]),
        instanceId: key,
      },
    });
    queryClient.setQueryData(serverQueryKeys.usageHubs(), [
      {
        id: "hub-1",
        label: "Home hub",
        url: "https://hub.example.ts.net:8318",
        checkedAt: "2026-08-30T12:00:00.000Z",
        accounts: [
          hubAccount("hub_a", "claude_acc1", "claudeAgent", 2, 2),
          hubAccount("hub_b", "claude_acc2", "claudeAgent", 65, 85),
          hubAccount("hub_c", "alpha@example.com", "codex", 10, 10),
        ],
      },
    ]);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="claudeAgent" />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("button", { name: /^Claude usage: 5h 90% remaining/ }))
      .toBeVisible();
    await expect
      .element(
        page.getByRole("button", {
          name: /^Claude · claude_acc1 \(Home hub\) usage: 5h 98% remaining, Weekly 98% remaining/,
        }),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByRole("button", {
          name: /^Claude · claude_acc2 \(Home hub\) usage: 5h 35% remaining, Weekly 15% remaining/,
        }),
      )
      .toBeVisible();
    expect(page.getByText(/alpha@example\.com/).query()).toBeNull();
  });

  it("shows one live warning on its account even without a usage snapshot, then clears on recovery", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: { claude_work: { driver: "claudeAgent", displayName: "Work" } },
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection
          provider="claudeAgent"
          activeInstanceId="claude_work"
          rateLimitStatus={{ status: "allowed_warning", utilization: 0.91 }}
        />
      </QueryClientProvider>,
    );
    await expect
      .element(page.getByRole("button", { name: /Claude · Work usage:.*Approaching rate limit/ }))
      .toBeVisible();
    expect(
      page.getByText("Approaching rate limit (91% used).", { exact: true }).all(),
    ).toHaveLength(1);
    expect(page.getByRole("button", { name: /Claude usage:/ }).query()).toBeNull();
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection
          provider="claudeAgent"
          activeInstanceId="claude_work"
          rateLimitStatus={null}
        />
      </QueryClientProvider>,
    );
    expect(
      page.getByText("Approaching rate limit (91% used).", { exact: true }).query(),
    ).toBeNull();
  });

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

  it("shows only the active provider's usage and updates when the provider changes", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [
        { window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 },
        { window: "5h", usedPercent: 5, windowDurationMins: 300 },
      ]),
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54, windowDurationMins: 10_080 }]),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="codex" />
      </QueryClientProvider>,
    );

    const codex = page.getByRole("button", {
      name: "Codex usage: 5h 95% remaining, Weekly 82% remaining",
    });
    await expect.element(codex).toBeVisible();
    expect(page.getByRole("button", { name: /Claude usage:/ }).query()).toBeNull();
    await expect.element(page.getByText("5h", { exact: true })).toBeVisible();
    await expect.element(codex.getByText("Weekly", { exact: true })).toBeVisible();

    await codex.click();

    await expect.element(page.getByText("95% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection provider="claudeAgent" />
      </QueryClientProvider>,
    );
    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 46% remaining" }))
      .toBeVisible();
    expect(page.getByRole("button", { name: /Codex usage:/ }).query()).toBeNull();
  });

  it("hides the section when only another provider has usage", async () => {
    const queryClient = createQueryClient();
    // Another provider's cached usage must not make the active provider's section appear.
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [{ window: "Weekly", usedPercent: 18 }]),
    ]);
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
      snapshot("codex", [{ window: "Weekly", usedPercent: 18 }]),
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
    expect(page.getByText("Usage", { exact: true }).query()).toBeNull();
  });
});
