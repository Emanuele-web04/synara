import { expect, test } from "@playwright/test";
import { preparePage, prepareRoute } from "../test-helpers";

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

  test("reaches the install and docs pages", async ({ page }) => {
    await preparePage(page, "light");
    await page.goto("/install", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText("Download Synara");
    await prepareRoute(page, "/docs", "light");
    await expect(page.locator("#nd-page")).toHaveAttribute("role", "main");
  });
});
