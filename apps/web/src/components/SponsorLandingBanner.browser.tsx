import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SponsorLandingBanner } from "./SponsorLandingBanner";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ shell: { openExternal } }),
}));

const storageKey = "synara:sponsor-landing-banner:dismissed:v1";

beforeEach(() => {
  localStorage.removeItem(storageKey);
  openExternal.mockClear();
});
afterEach(() => {
  localStorage.removeItem(storageKey);
});

it("opens the sponsor page externally without dismissing the banner", async () => {
  await render(<SponsorLandingBanner />);
  await page.getByRole("button", { name: /Support Synara/ }).click();
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://www.trysynara.com/sponsor");
  await expect.element(page.getByTestId("sponsor-landing-banner")).toBeVisible();
});

it("stays removed after it is dismissed without opening the sponsor page", async () => {
  const first = await render(<SponsorLandingBanner />);
  await page.getByRole("button", { name: "Dismiss sponsor banner" }).click();
  await expect.element(page.getByTestId("sponsor-landing-banner")).not.toBeInTheDocument();
  expect(openExternal).not.toHaveBeenCalled();
  await first.unmount();

  await render(<SponsorLandingBanner />);
  await expect.element(page.getByTestId("sponsor-landing-banner")).not.toBeInTheDocument();
});
