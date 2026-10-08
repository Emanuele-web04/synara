import "../../index.css";

import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";

const updateSettings = vi.hoisted(() => vi.fn());
vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({
    settings: {
      disabledProviders: ["codex", "claudeAgent"],
      railUsageProviders: ["codex", "claudeAgent"],
      railUsageInstanceIds: null,
      railUsageWindow: "both",
    },
    updateSettings,
  }),
}));

it("keeps disabled sidebar preferences when selecting another provider", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS);
  client.setQueryData(serverQueryKeys.allProviderUsage(), []);
  await render(
    <QueryClientProvider client={client}>
      <ProviderUsageSettingsPanel />
    </QueryClientProvider>,
  );
  await page
    .getByRole("switch", { name: "Show OpenCode usage at the bottom of the sidebar" })
    .click();
  expect(updateSettings).toHaveBeenCalledWith({
    railUsageInstanceIds: ["codex", "claudeAgent", "opencode"],
  });
});
