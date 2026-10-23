import "../index.css";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useEditorRailStore } from "../editorRailStore";
import { installEditorWorkspaceFixture, makeView } from "./EditorWorkspaceView.test-support";

vi.mock("~/betaFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/betaFeatures")>()),
  NATIVE_EDITOR_ON: false,
  CODE_EDITOR_ENGINE: "pierre",
}));

installEditorWorkspaceFixture();

it("keeps Stable navigation in its existing activity bar", async () => {
  await render(makeView()());
  await expect
    .element(page.getByRole("navigation", { name: "Editor activity bar", exact: true }), {
      timeout: 2_000,
    })
    .toBeVisible();
  expect(useEditorRailStore.getState().items).toBeNull();
  await page.getByRole("button", { name: "Search files", exact: true }).click();
  await expect.element(page.getByPlaceholder("Search files...")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Hide search sidebar", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Hide search sidebar", exact: true }).click();
  await expect.element(page.getByPlaceholder("Search files...")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Hide files sidebar", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});
