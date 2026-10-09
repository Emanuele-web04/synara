import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DesktopBridge } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ProductAnalyticsSettingsPanel } from "./ProductAnalyticsSettingsPanel";

const originalBridge = window.desktopBridge;
afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
});

it("persists consent and keeps the previous choice visible if saving fails", async () => {
  const setEnabled = vi.fn(async (enabled: boolean) => ({ enabled }));
  await page.viewport(820, 400);
  window.desktopBridge = {
    productAnalytics: { getState: async () => ({ enabled: false }), setEnabled, track: vi.fn() },
  } as unknown as DesktopBridge;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <div className="p-6">
        <ProductAnalyticsSettingsPanel />
      </div>
    </QueryClientProvider>,
  );
  const control = screen.getByRole("switch", { name: "Share product analytics" });
  await expect.element(control).toBeEnabled();
  await expect.element(control).not.toBeChecked();
  await control.click();
  await expect.element(control).toBeChecked();
  expect(setEnabled).toHaveBeenCalledWith(true);
  await page.screenshot({ path: "./__screenshots__/product-analytics-consent.png" });
  setEnabled.mockRejectedValueOnce(new Error("Cannot persist preference"));
  await control.click();
  await expect.element(screen.getByText(/Could not save your choice/)).toBeVisible();
  await expect.element(control).toBeChecked();
  await control.click();
  await expect.element(control).not.toBeChecked();
  client.clear();
});
