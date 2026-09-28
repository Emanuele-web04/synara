// FILE: EnvironmentUsageSection.browser.tsx
// Purpose: Browser coverage for the per-enabled-provider usage rows and multi-window summaries.

import "../../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type NativeApi,
  type ProviderKind,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const appSettingsMocks = vi.hoisted(() => ({
  useAppSettings: vi.fn(() => ({ settings: { codexHomePath: "" } })),
}));

vi.mock("~/appSettings", () => ({
  useAppSettings: appSettingsMocks.useAppSettings,
}));

import { serverQueryKeys } from "~/lib/serverReactQuery";

import { EnvironmentUsageSection } from "./EnvironmentUsageSection";

const enabledProviderSettings = {
  ...DEFAULT_SERVER_SETTINGS_VIEW,
  providers: Object.fromEntries(
    Object.entries(DEFAULT_SERVER_SETTINGS_VIEW.providers).map(([provider, settings]) => [
      provider,
      { ...settings, enabled: provider === "codex" || provider === "claudeAgent" },
    ]),
  ) as typeof DEFAULT_SERVER_SETTINGS_VIEW.providers,
};
let restoreNativeApi: (() => void) | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installUsageNativeApi(
  listProviderUsage: ReturnType<typeof vi.fn>,
  getProviderUsageSnapshot: ReturnType<typeof vi.fn>,
) {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      server: {
        getSettings: vi.fn().mockResolvedValue(enabledProviderSettings),
        listProviderUsage,
        getProviderUsageSnapshot,
      },
    } as unknown as NativeApi,
  });
  restoreNativeApi = () => {
    if (previousDescriptor) Object.defineProperty(window, "nativeApi", previousDescriptor);
    else Reflect.deleteProperty(window, "nativeApi");
  };
}

async function renderLiveSection() {
  await render(
    <QueryClientProvider client={createQueryClient(true)}>
      <EnvironmentUsageSection />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  restoreNativeApi?.();
  restoreNativeApi = undefined;
});

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

function createQueryClient(enabled = false): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, enabled } } });
}

describe("EnvironmentUsageSection", () => {
  it("waits for the shared batch instead of starting provider-scoped requests", async () => {
    const batch = deferred<ServerProviderUsageSnapshot[]>();
    const listProviderUsage = vi.fn(() => batch.promise);
    const getProviderUsageSnapshot = vi.fn();
    installUsageNativeApi(listProviderUsage, getProviderUsageSnapshot);

    await renderLiveSection();
    await vi.waitFor(() => expect(listProviderUsage).toHaveBeenCalledTimes(1));
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();

    batch.resolve([
      snapshot("codex", [{ window: "5h", usedPercent: 5, windowDurationMins: 300 }]),
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54 }]),
    ]);
    await expect
      .element(page.getByRole("button", { name: "Codex usage: 5h 95% remaining" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 46% remaining" }))
      .toBeVisible();
    expect(getProviderUsageSnapshot).not.toHaveBeenCalled();
  });

  it("falls back locally when the settled batch omits a provider", async () => {
    const batch = deferred<ServerProviderUsageSnapshot[]>();
    const getProviderUsageSnapshot = vi.fn(({ provider }: { provider: ProviderKind }) =>
      Promise.resolve(snapshot(provider, [{ window: "Weekly", usedPercent: 27 }])),
    );
    installUsageNativeApi(
      vi.fn(() => batch.promise),
      getProviderUsageSnapshot,
    );

    await renderLiveSection();
    batch.resolve([snapshot("codex", [{ window: "5h", usedPercent: 5 }])]);

    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 73% remaining" }))
      .toBeVisible();
    expect(getProviderUsageSnapshot).toHaveBeenCalledTimes(1);
    expect(getProviderUsageSnapshot).toHaveBeenCalledWith({ provider: "claudeAgent" });
  });

  it("falls back locally after the shared batch fails", async () => {
    const batch = deferred<ServerProviderUsageSnapshot[]>();
    const getProviderUsageSnapshot = vi.fn(({ provider }: { provider: ProviderKind }) =>
      Promise.resolve(
        snapshot(provider, [{ window: provider === "codex" ? "5h" : "Weekly", usedPercent: 40 }]),
      ),
    );
    installUsageNativeApi(
      vi.fn(() => batch.promise),
      getProviderUsageSnapshot,
    );

    await renderLiveSection();
    batch.reject(new Error("batch unavailable"));

    await expect
      .element(page.getByRole("button", { name: "Codex usage: 5h 60% remaining" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Claude usage: Weekly 60% remaining" }))
      .toBeVisible();
    expect(getProviderUsageSnapshot).toHaveBeenCalledTimes(2);
  });

  it("renders one row per enabled provider with every reported usage window", async () => {
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
    await expect.element(codex.getByText("5h", { exact: true })).toBeVisible();
    await expect.element(codex.getByText("Weekly", { exact: true })).toBeVisible();

    await codex.click();

    await expect.element(page.getByText("95% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();
  });

  it("hides the disabled provider's row but keeps the others", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [{ window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 }]),
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
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("button", { name: "Codex usage: Weekly 82% remaining" }))
      .toBeVisible();
    expect(document.querySelector('button[aria-label^="Cursor usage:"]')).toBeNull();
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

  it("hides the section entirely when no enabled provider has anything displayable", async () => {
    const queryClient = createQueryClient();
    // Empty batch and no local/thread fallback produces rows: nothing renders, not even the
    // "Usage" label, until some source yields data.
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    expect(document.querySelector('button[aria-label*="usage:"]')).toBeNull();
    // The "Usage" label itself renders as a <p>; with every row hidden nothing may mount.
    expect(document.querySelector("p")).toBeNull();
  });
});
