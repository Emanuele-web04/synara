// FILE: EnvironmentUsageSection.browser.tsx
// Purpose: Browser coverage for the active-provider usage row and multi-window summaries.

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

describe("EnvironmentUsageSection", () => {
  it("renders only the active provider with every reported usage window", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [
        { window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 },
        { window: "5h", usedPercent: 5, windowDurationMins: 300 },
      ]),
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54, windowDurationMins: 10_080 }]),
      snapshot("cursor", [{ window: "Current", usedPercent: 30 }]),
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
    expect(document.querySelector('button[aria-label^="Claude usage:"]')).toBeNull();
    expect(document.querySelector('button[aria-label^="Cursor usage:"]')).toBeNull();
    expect(appSettingsMocks.useAppSettings).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(serverQueryKeys.providerUsage("codex", null))).toBeUndefined();
    await expect.element(page.getByText("5h", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Weekly", { exact: true })).toBeVisible();

    await codex.click();

    await expect.element(page.getByText("95% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();
  });

  it("hides the section when the active provider is disabled", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
