import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// macOS desktop: the only platform where the translucent shell and desktop blur apply.
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/utils")>()),
  isMacNavigatorPlatform: () => true,
}));

import { ThemePackEditor } from "./ThemePackEditor";
import { DEFAULT_THEME_STATE, parseStoredThemeState } from "~/theme/theme.logic";

const root = document.documentElement;
const setWindowMaterial = vi.fn(async () => true);
let previousTheme: string | null;

beforeEach(() => {
  previousTheme = localStorage.getItem("synara:theme");
  setWindowMaterial.mockClear();
  window.desktopBridge = {
    setTheme: async () => {},
    setWindowMaterial,
  } as unknown as NonNullable<typeof window.desktopBridge>;
});

afterEach(() => {
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  if (previousTheme === null) localStorage.removeItem("synara:theme");
  else localStorage.setItem("synara:theme", previousTheme);
  window.dispatchEvent(new StorageEvent("storage", { key: "synara:theme" }));
});

// Playwright cannot fill range inputs; drive them the way a drag does, through React's
// value tracker and a native input event.
function setSliderValue(label: string, value: number) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing slider ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    String(value),
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("tunes opacity, desktop blur, and scope, then switches to a solid window", async () => {
  localStorage.setItem("synara:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: "dark" }));
  await render(<ThemePackEditor variant="dark" />);
  await expect.poll(() => root.getAttribute("data-window-material")).toBe("translucent");
  await expect.poll(() => root.getAttribute("data-window-translucency")).toBe("sidebar");

  const opacity = page.getByRole("slider", { name: "Dark theme translucency opacity" });
  const blur = page.getByRole("slider", { name: "Dark theme background blur" });
  await expect.element(opacity).toHaveValue("72");
  await expect.element(blur).toHaveValue("30");
  // Untouched defaults keep the system vibrancy material rather than a custom blur.
  await expect
    .poll(() => setWindowMaterial.mock.lastCall)
    .toEqual([{ material: "opaque", blurRadius: 0 }]);

  // Both sliders stop at a floor: no fill over no blur would leave a see-through window.
  setSliderValue("Dark theme translucency opacity", 0);
  setSliderValue("Dark theme background blur", 0);
  await expect
    .poll(() => root.style.getPropertyValue("--app-sidebar-surface"))
    .toMatch(/ 15%, transparent\)$/);

  await page.getByRole("switch", { name: "Dark theme translucent sidebar only" }).click();
  await expect.poll(() => root.getAttribute("data-window-translucency")).toBe("window");
  await expect
    .poll(() => root.style.getPropertyValue("--app-window-background"))
    .toMatch(/ 15%, transparent\)$/);
  // The coat has to actually paint on the body, not only exist as a variable.
  const bodyAlpha = () =>
    Number(getComputedStyle(document.body).backgroundColor.match(/[\d.]+(?=\)$)/)?.[0]);
  await expect.poll(bodyAlpha).toBeCloseTo(0.15, 2);
  setSliderValue("Dark theme translucency opacity", 60);
  await expect.poll(bodyAlpha).toBeCloseTo(0.6, 2);
  await expect
    .poll(() => setWindowMaterial.mock.lastCall)
    .toEqual([{ material: "translucent", blurRadius: 1 }]);
  expect(parseStoredThemeState(localStorage.getItem("synara:theme")).translucency.dark).toEqual({
    opacity: 60,
    blur: 1,
    sidebarOnly: false,
  });

  await page.getByRole("button", { name: "Dark theme automatic background blur" }).click();
  await expect
    .poll(() => setWindowMaterial.mock.lastCall)
    .toEqual([{ material: "opaque", blurRadius: 0 }]);
  expect(
    parseStoredThemeState(localStorage.getItem("synara:theme")).translucency.dark.blur,
  ).toBeNull();

  await page.getByRole("radio", { name: "Solid" }).click();
  await expect.poll(() => root.getAttribute("data-window-material")).toBe("opaque");
  expect(root.getAttribute("data-window-translucency")).toBe("none");
  await expect
    .poll(() => setWindowMaterial.mock.lastCall)
    .toEqual([{ material: "opaque", blurRadius: 0 }]);
  await expect.element(opacity).not.toBeInTheDocument();
});
