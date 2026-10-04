import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ProjectImportLandingBanner } from "../projectImport/ProjectImportLandingBanner";
import { useProjectImportDialogStore } from "../projectImport/projectImportDialogStore";

const storageKey = "synara:project-import-landing-banner:dismissed:v1";

beforeEach(() => {
  localStorage.removeItem(storageKey);
  useProjectImportDialogStore.setState({ isOpen: false, initialProviders: null });
});
afterEach(() => {
  localStorage.removeItem(storageKey);
});

it("opens the project import dialog without dismissing the banner", async () => {
  await render(<ProjectImportLandingBanner />);
  await page.getByRole("button", { name: /Import your Claude Code and Codex projects/ }).click();
  expect(useProjectImportDialogStore.getState().isOpen).toBe(true);
  await expect.element(page.getByTestId("project-import-landing-banner")).toBeInTheDocument();
});

it("stays removed after it is dismissed", async () => {
  const first = await render(<ProjectImportLandingBanner />);
  await page.getByRole("button", { name: "Dismiss project import banner" }).click();
  await expect.element(page.getByTestId("project-import-landing-banner")).not.toBeInTheDocument();
  // Dismissal must not open the import dialog through the surrounding block.
  expect(useProjectImportDialogStore.getState().isOpen).toBe(false);
  await first.unmount();

  await render(<ProjectImportLandingBanner />);
  await expect.element(page.getByTestId("project-import-landing-banner")).not.toBeInTheDocument();
});
