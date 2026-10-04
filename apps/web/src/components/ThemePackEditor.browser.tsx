import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// Windows/Linux desktop use the opaque projection, without macOS vibrancy.
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/utils")>()),
  isMacNavigatorPlatform: () => false,
}));

import { ThemePackEditor } from "./ThemePackEditor";
import { DEFAULT_THEME_STATE, parseStoredThemeState } from "~/theme/theme.logic";

const root = document.documentElement;
let previousTheme: string | null;

beforeEach(() => {
  previousTheme = localStorage.getItem("synara:theme");
});

afterEach(() => {
  if (previousTheme === null) localStorage.removeItem("synara:theme");
  else localStorage.setItem("synara:theme", previousTheme);
  window.dispatchEvent(new StorageEvent("storage", { key: "synara:theme" }));
});

async function selectLightPreset(label: string) {
  await page.getByRole("combobox", { name: "Light theme code theme" }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

it("applies and persists Vercel light colors on an opaque desktop, then restores Codex", async () => {
  localStorage.setItem("synara:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: "light" }));
  await render(<ThemePackEditor variant="light" />);
  await expect.poll(() => root.getAttribute("data-code-theme-id")).toBe("codex");
  expect(root.getAttribute("data-window-material")).toBe("opaque");

  await selectLightPreset("Vercel");
  await expect.poll(() => root.style.getPropertyValue("--codex-base-accent")).toBe("#006aff");
  expect(getComputedStyle(root).getPropertyValue("--color-text-foreground").trim()).toBe("#171717");
  expect(root.style.getPropertyValue("--codex-base-surface")).toBe("#ffffff");
  expect(parseStoredThemeState(localStorage.getItem("synara:theme")).codeThemeIds.light).toBe(
    "vercel",
  );
  await expect
    .element(page.getByRole("img", { name: "Light theme preview: Vercel" }))
    .toBeVisible();

  await selectLightPreset("Codex");
  await expect.poll(() => root.style.getPropertyValue("--codex-base-accent")).toBe("#0169cc");
  expect(root.style.getPropertyValue("--color-text-foreground")).toBe("#0d0d0d");
});

it("previews an inactive light preset and applies it only when the user chooses Use light theme", async () => {
  localStorage.setItem("synara:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: "dark" }));
  await render(<ThemePackEditor variant="light" />);
  await selectLightPreset("Vercel");

  expect(root.getAttribute("data-theme-variant")).toBe("dark");
  expect(root.getAttribute("data-code-theme-id")).toBe("codex");
  const preview = page.getByRole("img", { name: "Light theme preview: Vercel" });
  expect(getComputedStyle(preview.element()).backgroundColor).toBe("rgb(255, 255, 255)");
  expect(getComputedStyle(preview.element()).color).toBe("rgb(23, 23, 23)");

  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect.poll(() => root.getAttribute("data-theme-variant")).toBe("light");
  expect(root.getAttribute("data-code-theme-id")).toBe("vercel");
  const saved = parseStoredThemeState(localStorage.getItem("synara:theme"));
  expect(saved.mode).toBe("light");
  expect(saved.codeThemeIds.dark).toBe("codex");
  expect(saved.systemUiFont).toBe(true);
});
