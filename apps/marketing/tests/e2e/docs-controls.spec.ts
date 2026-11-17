import { expect, test } from "@playwright/test";
import { prepareRoute } from "../test-helpers";

test.describe("documentation chrome", () => {
  test("desktop sidebar toggles theme and links Download to /install", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await prepareRoute(page, "/docs", "light");
    await expect(page.locator("#nd-page")).toHaveAttribute("role", "main");

    const sidebar = page.locator("#nd-sidebar");
    const theme = sidebar.getByRole("button", { name: "Switch to dark mode" });
    await expect(sidebar.getByRole("link", { name: "Download", exact: true })).toHaveAttribute(
      "href",
      "/install",
    );

    await theme.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(sidebar.getByRole("button", { name: "Switch to light mode" })).toBeVisible();
  });

  test("mobile top bar toggles theme and the drawer links Download", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareRoute(page, "/docs", "light");

    const header = page.locator("#nd-subnav");
    await header.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await header.getByRole("button", { name: "Open Sidebar" }).click();
    const drawer = page.locator("#nd-sidebar-mobile");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Download", exact: true })).toHaveAttribute(
      "href",
      "/install",
    );
  });
});
