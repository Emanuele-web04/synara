import { expect, test } from "@playwright/test";
import { assertNoOverflow, prepareRoute } from "../test-helpers";

test("shows unavailable Linux formats without pretending to download them", async ({ page }) => {
  await prepareRoute(page, "/install", "light");
  const linux = page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: "Linux", exact: true }) })
    .filter({ has: page.getByRole("group", { name: "Linux package format" }) })
    .last();
  const formats = page.getByRole("group", { name: "Linux package format" });
  await expect(formats.getByRole("button", { name: "AppImage", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(linux.getByRole("link", { name: "Download", exact: true })).toHaveAttribute(
    "href",
    /\.AppImage$/,
  );
  for (const format of [".deb", ".rpm"]) {
    await formats.getByRole("button", { name: format, exact: true }).click();
    await expect(formats.getByRole("button", { name: format, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(linux.getByRole("button", { name: "Unavailable in this release" })).toBeDisabled();
    await expect(linux.getByRole("link", { name: "Download", exact: true })).toHaveCount(0);
  }
  await formats.getByRole("button", { name: "AppImage", exact: true }).click();
  await expect(linux.getByRole("link", { name: "Download", exact: true })).toHaveAttribute(
    "href",
    /\.AppImage$/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoOverflow(page);
});
