import "../../index.css";

import type { ServerUsageHub } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { UsageHubsSection } from "./UsageHubsSection";

const hub: ServerUsageHub = {
  id: "hub-1",
  label: "Home hub",
  url: "https://hub.example.ts.net:8318",
  checkedAt: "2026-11-26T12:00:00.000Z",
  accounts: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps a removed hub gone when a poll that started earlier resolves", async () => {
  let resolvePoll: ((hubs: ServerUsageHub[]) => void) | undefined;
  const listUsageHubs = vi.fn(
    () =>
      new Promise<ServerUsageHub[]>((resolve) => {
        resolvePoll = resolve;
      }),
  );
  const removeUsageHub = vi.fn(async () => undefined);
  vi.stubGlobal("nativeApi", {
    server: { listUsageHubs, removeUsageHub },
    dialogs: { confirm: async () => true },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(serverQueryKeys.usageHubs(), [hub]);
  try {
    await render(
      <QueryClientProvider client={client}>
        <UsageHubsSection />
      </QueryClientProvider>,
    );
    await expect.element(page.getByText("Home hub")).toBeVisible();

    // A background poll is in flight when the user removes the hub.
    void client.refetchQueries({ queryKey: serverQueryKeys.usageHubs() });
    await vi.waitFor(() => expect(listUsageHubs).toHaveBeenCalled());
    await page.getByRole("button", { name: "Remove" }).click();
    await vi.waitFor(() => expect(removeUsageHub).toHaveBeenCalledWith({ id: "hub-1" }));
    await expect.element(page.getByText("Home hub")).not.toBeInTheDocument();

    resolvePoll?.([hub]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(page.getByText("Home hub").query()).toBeNull();
  } finally {
    client.clear();
  }
});
