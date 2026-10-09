// FILE: EnvironmentUsageSection.browser.tsx
// Purpose: Browser coverage for provider-account usage rows and multi-window summaries.

import "../../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type NativeApi,
  type ProviderKind,
  type ServerListProviderUsageInput,
  type ServerProviderUsageSnapshot,
  type ServerSettingsView,
} from "@synara/contracts";
import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const appSettingsMocks = vi.hoisted(() => ({
  useAppSettings: vi.fn(() => ({ settings: { codexHomePath: "" } })),
}));

vi.mock("~/appSettings", () => ({
  useAppSettings: appSettingsMocks.useAppSettings,
}));

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { providerUsageAccountFallbackQueryOptions } from "~/lib/providerUsageAccountQueries";
import { deferred } from "~/lib/pullRequestReactQuery.testUtils";

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

function createQueryClient(live = false): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (!live) {
    for (const provider of PROVIDER_USAGE_PROVIDERS) {
      queryClient.setQueryData(
        providerUsageAccountFallbackQueryOptions({ provider, enabled: false }).queryKey,
        [],
      );
    }
  }
  return queryClient;
}

function enabledSettings(providers: ReadonlyArray<ProviderKind>): ServerSettingsView {
  const enabledProviders = new Set(providers);
  return {
    ...DEFAULT_SERVER_SETTINGS_VIEW,
    providers: Object.fromEntries(
      Object.entries(DEFAULT_SERVER_SETTINGS_VIEW.providers).map(([provider, settings]) => [
        provider,
        { ...settings, enabled: enabledProviders.has(provider as ProviderKind) },
      ]),
    ) as ServerSettingsView["providers"],
  };
}

let restoreNativeApi: (() => void) | undefined;
function installUsageNativeApi(
  listProviderUsage: ReturnType<typeof vi.fn>,
  settings: ServerSettingsView = enabledSettings(["codex", "claudeAgent"]),
) {
  const getProviderUsageSnapshot = vi.fn();
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      server: {
        getSettings: vi.fn().mockResolvedValue(settings),
        listProviderUsage,
        getProviderUsageSnapshot,
      },
    } as unknown as NativeApi,
  });
  restoreNativeApi = () => {
    if (previousDescriptor) Object.defineProperty(window, "nativeApi", previousDescriptor);
    else Reflect.deleteProperty(window, "nativeApi");
  };
  return { getProviderUsageSnapshot };
}

async function renderLiveSection(queryClient = createQueryClient(true)) {
  return render(
    <QueryClientProvider client={queryClient}>
      <EnvironmentUsageSection />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  restoreNativeApi?.();
  restoreNativeApi = undefined;
});

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
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    const personal = page.getByRole("button", { name: "Codex · Personal usage: Sign in" });
    await expect.element(personal).toBeVisible();
    await personal.click();
    await expect.element(page.getByText("Sign in to Personal.", { exact: true })).toBeVisible();
    expect(page.getByText("40% left", { exact: true }).query()).toBeNull();
  });

  it("shows every enabled provider's usage and keeps it when the active provider changes", async () => {
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
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    const codex = page.getByRole("button", {
      name: "Codex usage: 5h 95% remaining, Weekly 82% remaining",
    });
    await expect.element(codex).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 46% remaining" }))
      .toBeVisible();
    await expect.element(page.getByText("5h", { exact: true })).toBeVisible();
    await expect.element(codex.getByText("Weekly", { exact: true })).toBeVisible();

    await codex.click();

    await expect.element(page.getByText("95% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );
    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 46% remaining" }))
      .toBeVisible();
    await expect.element(codex).toBeVisible();
  });

  it("keeps the section when only another provider has usage", async () => {
    const queryClient = createQueryClient();
    // The active chat's provider does not own the shared usage section.
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [{ window: "Weekly", usedPercent: 18 }]),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    expect(document.querySelector('button[aria-label^="Claude usage:"]')).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Codex usage: Weekly 82% remaining" }))
      .toBeVisible();
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
        <EnvironmentUsageSection />
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
        <EnvironmentUsageSection />
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
        <EnvironmentUsageSection />
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
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("button", { name: "Droid usage: Connected" }))
      .toBeVisible();
  });

  it("hides a disabled provider's cached usage but keeps other enabled providers", async () => {
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
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    expect(document.querySelector('button[aria-label^="Cursor usage:"]')).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Codex usage: Weekly 82% remaining" }))
      .toBeVisible();
  });

  it("hides disabled and removed sibling accounts without hiding the other provider", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      { ...snapshot("codex", [{ window: "Weekly", usedPercent: 18 }]), instanceId: "codex" },
      { ...snapshot("codex", [{ window: "Weekly", usedPercent: 60 }]), instanceId: "codex_work" },
      { ...snapshot("codex", [{ window: "Weekly", usedPercent: 90 }]), instanceId: "removed" },
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54 }]),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: { codex_work: { driver: "codex", displayName: "Work", enabled: false } },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("button", { name: "Codex usage: Weekly 82% remaining" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 46% remaining" }))
      .toBeVisible();
    expect(page.getByRole("button", { name: /Work usage:/ }).query()).toBeNull();
    expect(page.getByRole("button", { name: /Removed usage:/ }).query()).toBeNull();
  });

  it("suppresses the label and divider when every enabled account has no data", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", []),
      { ...snapshot("claudeAgent", []), status: "needs-auth" },
      { ...snapshot("codex", []), instanceId: "codex_work" },
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: { codex_work: { driver: "codex", displayName: "Work" } },
    });

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    expect(page.getByText("Usage", { exact: true }).query()).toBeNull();
    expect(document.querySelector('button[aria-label*="usage:"]')).toBeNull();
    expect(screen.container.children).toHaveLength(0);
  });

  it("waits for the shared batch without provider or account request fan-out", async () => {
    const batch = deferred<ServerProviderUsageSnapshot[]>();
    const listProviderUsage = vi.fn(() => batch.promise);
    const { getProviderUsageSnapshot } = installUsageNativeApi(listProviderUsage, {
      ...enabledSettings(["codex", "claudeAgent"]),
      providerInstances: { codex_work: { driver: "codex", displayName: "Work" } },
    });

    await renderLiveSection();
    await vi.waitFor(() => expect(listProviderUsage).toHaveBeenCalledTimes(1));
    expect(listProviderUsage).toHaveBeenCalledWith({});
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();
    expect(page.getByText("Usage", { exact: true }).query()).toBeNull();

    batch.resolve([
      { ...snapshot("codex", [{ window: "5h", usedPercent: 5 }]), instanceId: "codex" },
      { ...snapshot("codex", [{ window: "5h", usedPercent: 50 }]), instanceId: "codex_work" },
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54 }]),
    ]);
    await expect
      .element(
        page.getByRole("button", { name: "Codex · Default account usage: 5h 95% remaining" }),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Codex · Work usage: 5h 50% remaining" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 46% remaining" }))
      .toBeVisible();
    expect(listProviderUsage).toHaveBeenCalledTimes(1);
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();
  });

  it("recovers multiple missing accounts through one account-safe provider batch", async () => {
    const batch = deferred<ServerProviderUsageSnapshot[]>();
    const recovery = deferred<ServerProviderUsageSnapshot[]>();
    const listProviderUsage = vi.fn((input: ServerListProviderUsageInput) =>
      input.provider ? recovery.promise : batch.promise,
    );
    const { getProviderUsageSnapshot } = installUsageNativeApi(listProviderUsage, {
      ...enabledSettings(["codex", "claudeAgent"]),
      providerInstances: {
        codex_work: { driver: "codex", displayName: "Work" },
        codex_team: { driver: "codex", displayName: "Team" },
        codex_disabled: { driver: "codex", displayName: "Disabled", enabled: false },
      },
    });

    await renderLiveSection();
    await vi.waitFor(() => expect(listProviderUsage).toHaveBeenCalledTimes(1));
    batch.resolve([
      { ...snapshot("codex", [{ window: "Weekly", usedPercent: 18 }]), instanceId: "codex" },
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54 }]),
    ]);
    await vi.waitFor(() => expect(listProviderUsage).toHaveBeenCalledTimes(2));
    expect(listProviderUsage).toHaveBeenLastCalledWith({ provider: "codex" });
    expect(page.getByRole("button", { name: /Work usage:/ }).query()).toBeNull();

    recovery.resolve([
      { ...snapshot("codex", [{ window: "Weekly", usedPercent: 99 }]), instanceId: "codex" },
      { ...snapshot("codex", [{ window: "Weekly", usedPercent: 60 }]), instanceId: "codex_work" },
      { ...snapshot("codex", [{ window: "Weekly", usedPercent: 70 }]), instanceId: "codex_team" },
      {
        ...snapshot("codex", [{ window: "Weekly", usedPercent: 80 }]),
        instanceId: "codex_disabled",
      },
    ]);

    await expect
      .element(
        page.getByRole("button", { name: "Codex · Default account usage: Weekly 82% remaining" }),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Codex · Team usage: Weekly 30% remaining" }))
      .toBeVisible();
    const work = page.getByRole("button", { name: "Codex · Work usage: Weekly 40% remaining" });
    await expect.element(work).toBeVisible();
    await work.click();
    await expect.element(page.getByText("40% left", { exact: true })).toBeVisible();
    expect(page.getByText("82% left", { exact: true }).query()).toBeNull();
    expect(page.getByRole("button", { name: /Disabled usage:/ }).query()).toBeNull();
    expect(listProviderUsage).toHaveBeenCalledTimes(2);
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();
  });

  it("recovers after a failed shared batch without substituting provider-wide local usage", async () => {
    const batch = deferred<ServerProviderUsageSnapshot[]>();
    const listProviderUsage = vi.fn((input: ServerListProviderUsageInput) =>
      input.provider
        ? Promise.resolve([
            {
              ...snapshot(input.provider, [{ window: "Weekly", usedPercent: 40 }]),
              instanceId: input.provider,
            },
          ])
        : batch.promise,
    );
    const { getProviderUsageSnapshot } = installUsageNativeApi(listProviderUsage);

    await renderLiveSection();
    await vi.waitFor(() => expect(listProviderUsage).toHaveBeenCalledTimes(1));
    batch.reject(new Error("Shared batch unavailable"));

    await expect
      .element(page.getByRole("button", { name: "Codex usage: Weekly 60% remaining" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 60% remaining" }))
      .toBeVisible();
    expect(listProviderUsage).toHaveBeenCalledTimes(3);
    expect(listProviderUsage).toHaveBeenCalledWith({ provider: "codex" });
    expect(listProviderUsage).toHaveBeenCalledWith({ provider: "claudeAgent" });
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();
  });

  it("keeps recovered usage visible without recovery fan-out during a pending batch refresh", async () => {
    const batchRefresh = deferred<ServerProviderUsageSnapshot[]>();
    const queryClient = createQueryClient(true);
    let batchCalls = 0;
    const listProviderUsage = vi.fn((input: ServerListProviderUsageInput) => {
      if (input.provider)
        return Promise.resolve([snapshot("codex", [{ window: "Weekly", usedPercent: 40 }])]);
      batchCalls += 1;
      return batchCalls === 1 ? Promise.resolve([]) : batchRefresh.promise;
    });
    const { getProviderUsageSnapshot } = installUsageNativeApi(
      listProviderUsage,
      enabledSettings(["codex"]),
    );

    await renderLiveSection(queryClient);
    const codex = page.getByRole("button", { name: "Codex usage: Weekly 60% remaining" });
    await expect.element(codex).toBeVisible();
    expect(listProviderUsage).toHaveBeenCalledTimes(2);

    const refreshed = queryClient.invalidateQueries({
      queryKey: serverQueryKeys.allProviderUsage(),
    });
    await vi.waitFor(() => expect(listProviderUsage).toHaveBeenCalledTimes(3));
    await expect.element(codex).toBeVisible();
    expect(listProviderUsage.mock.calls.filter(([input]) => input.provider)).toHaveLength(1);
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();

    batchRefresh.resolve([snapshot("codex", [{ window: "Weekly", usedPercent: 10 }])]);
    await refreshed;
    await expect
      .element(page.getByRole("button", { name: "Codex usage: Weekly 90% remaining" }))
      .toBeVisible();
    expect(listProviderUsage).toHaveBeenCalledTimes(3);
  });

  it("shows unavailable account rows if recovery fails instead of reporting connected or loading", async () => {
    const listProviderUsage = vi.fn((input: ServerListProviderUsageInput) =>
      input.provider ? Promise.reject(new Error("Recovery unavailable")) : Promise.resolve([]),
    );
    const { getProviderUsageSnapshot } = installUsageNativeApi(listProviderUsage, {
      ...enabledSettings(["codex"]),
      providerInstances: { codex_work: { driver: "codex", displayName: "Work" } },
    });

    await renderLiveSection();

    await expect
      .element(page.getByRole("button", { name: "Codex · Default account usage: Unavailable" }))
      .toBeVisible();
    const work = page.getByRole("button", { name: "Codex · Work usage: Unavailable" });
    await expect.element(work).toBeVisible();
    await work.click();
    await expect
      .element(page.getByText("Usage could not be read for this account.", { exact: true }))
      .toBeVisible();
    expect(page.getByText("Connected", { exact: true }).query()).toBeNull();
    expect(page.getByText(/Scanning local usage/).query()).toBeNull();
    expect(listProviderUsage).toHaveBeenCalledTimes(2);
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a successful empty recovery suppressed rather than inventing an account error", async () => {
    const listProviderUsage = vi.fn().mockResolvedValue([]);
    const { getProviderUsageSnapshot } = installUsageNativeApi(
      listProviderUsage,
      enabledSettings(["codex"]),
    );

    const screen = await renderLiveSection();
    await vi.waitFor(() => expect(listProviderUsage).toHaveBeenCalledTimes(2));

    expect(screen.container.children).toHaveLength(0);
    expect(page.getByText("Usage", { exact: true }).query()).toBeNull();
    expect(page.getByRole("button", { name: /Unavailable/ }).query()).toBeNull();
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();
  });
});
