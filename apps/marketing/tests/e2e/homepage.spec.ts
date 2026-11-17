import { expect, test } from "@playwright/test";
import { preparePage } from "../test-helpers";
import releaseDownloads from "../../src/data/latest-release-downloads.json" with { type: "json" };

test.describe("homepage functional flow", () => {
  test("hero links to install and GitHub", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await preparePage(page, "light");

    await expect(page.locator("h1")).toHaveText("Run every coding agent in one workspace");

    const actions = page.locator("[data-home-actions]");
    await expect(
      actions.getByRole("link", { name: /Download for|Download Synara/ }),
    ).toHaveAttribute("href", "/install");
    await expect(actions.getByRole("link", { name: "Star on GitHub" })).toHaveAttribute(
      "href",
      /github\.com/,
    );
  });

  test("supports mobile navigation, FAQ disclosure and theme toggle", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await preparePage(page, "light");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("button", { name: "Close navigation" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();

    const faq = page.getByRole("button", { name: /What is Synara/ }).first();
    await faq.press("Enter");
    await expect(faq).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[role="region"]').first()).toBeVisible();

    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("selects the correct release installer for each platform", async ({ page }) => {
    await page.goto("/install", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText("Download Synara");
    // The recommendation appears once the installer controls have hydrated.
    await expect(page.getByText("For your device", { exact: true })).toBeVisible();
    const { version } = releaseDownloads;
    const releaseRoot = "https://github.com/Emanuele-web04/synara/releases";
    const assetRoot = `${releaseRoot}/download/${version}/Synara-${version.slice(1)}`;
    const download = (platform: string) =>
      page
        .getByRole("heading", { name: platform, exact: true })
        .locator("..")
        .getByRole("link", { name: "Download", exact: true });

    for (const [platform, suffix] of [
      ["Windows", "x64.exe"],
      ["Linux", "x86_64.AppImage"],
    ]) {
      await expect(download(platform)).toHaveAttribute("href", `${assetRoot}-${suffix}`);
    }
    await page.getByRole("button", { name: "Apple Silicon", exact: true }).click();
    await expect(download("macOS")).toHaveAttribute("href", `${assetRoot}-arm64.dmg`);
    await page.getByRole("button", { name: "Intel", exact: true }).click();
    await expect(download("macOS")).toHaveAttribute("href", `${assetRoot}-x64.dmg`);
    await page.getByRole("button", { name: "ARM64", exact: true }).click();
    await expect(download("Linux")).toHaveAttribute("href", releaseDownloads.linux.arm64);
    await expect(page.getByRole("link", { name: "Browse all releases" })).toHaveAttribute(
      "href",
      `${releaseRoot}/tag/${version}`,
    );
  });
});
