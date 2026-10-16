import { test, expect } from "playwright/test";
import { openEditorAcceptanceApp } from "./editorAcceptanceFixture";
import { capture } from "./extensionAcceptanceControls";

const id = "esbenp.prettier-vscode";
// Real Synara, real registry and validated package installation. No route or RPC mocks.
test("native marketplace discovery, details, install, permissions and responsive themes", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openEditorAcceptanceApp(page);
  await page.goto("/settings?section=extensions");
  if (process.env.SYNARA_MARKETPLACE_BASELINE === "1") {
    await expect(page.getByRole("textbox", { name: "Search Open VSX" })).toBeVisible();
    await capture(page, info, "marketplace-before");
    return;
  }
  try {
    await expect(page.getByRole("heading", { name: "Tools for the way you code" })).toBeVisible();
    const cards = page.getByTestId("extension-card");
    await expect(cards.first()).toBeVisible({ timeout: 40_000 });
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
    await capture(page, info, "marketplace-after-discover");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    await expect(cards.first()).toBeVisible({ timeout: 40_000 });
    await page.getByRole("button", { name: "Formatters", exact: true }).click();
    await expect(page.getByRole("button", { name: "Formatters", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(cards.first()).toBeVisible({ timeout: 40_000 });
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("textbox", { name: "Search Open VSX" }).fill(id);
    await expect(cards).toHaveCount(1, { timeout: 40_000 });
    await expect(cards.first()).toContainText(id);
    await cards
      .first()
      .getByRole("button", { name: /^Details for/ })
      .click();
    const details = page.getByRole("dialog");
    await expect(
      details.getByRole("button", { name: "Install compatible version", exact: true }),
    ).toBeEnabled({ timeout: 40_000 });
    await capture(page, info, "marketplace-after-details");
    await details.getByRole("button", { name: "Install compatible version", exact: true }).click();
    await expect(details.getByRole("button", { name: "Manage installed extension" })).toBeEnabled({
      timeout: 90_000,
    });
    await details.getByRole("button", { name: "Manage installed extension" }).click();
    const installed = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Installed extensions", exact: true }) });
    await expect(installed).toContainText(id);
    await expect(installed.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
    const snapshot = await page.evaluate(async () => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      return ensureNativeApi().editor.extensions({ operation: "list" });
    });
    expect(snapshot.extensions.find((entry: { id: string }) => entry.id === id)).toMatchObject({
      enabled: false,
      approved: false,
    });
    expect(snapshot.trustedWorkspaces).toEqual([]);
    expect(snapshot.runtime).not.toBe("running");
    await capture(page, info, "marketplace-after-installed");
    await page.getByRole("radio", { name: "Permissions", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Workspace directory" })).toBeVisible();
    await page.getByRole("radio", { name: "Marketplace", exact: true }).click();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(cards.first()).toBeVisible({ timeout: 40_000 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await capture(page, info, "marketplace-after-dark");
    await page.setViewportSize({ width: 1024, height: 768 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await capture(page, info, "marketplace-after-compact");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("radio", { name: /^Installed/ }).click();
    await installed.getByRole("button", { name: "Remove", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove extension", exact: true })
      .click();
    await expect(page.getByText("No editor extensions installed.", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await info.attach("marketplace-evidence", {
      body: JSON.stringify({
        id,
        liveRegistry: true,
        pagination: true,
        details: true,
        disabledInstallation: true,
        noExecutionOrTrustGranted: true,
        removed: true,
      }),
      contentType: "application/json",
    });
  } finally {
    await page.evaluate(async (id) => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      const extensions = ensureNativeApi().editor.extensions;
      const state = await extensions({ operation: "list" });
      const entry = state.extensions.find(
        (candidate: { id: string; version: string }) => candidate.id === id,
      );
      if (entry) await extensions({ operation: "remove", id: entry.id, version: entry.version });
    }, id);
  }
});
