import "../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// Windows/Linux desktop use the opaque projection, without macOS vibrancy.
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/utils")>()),
  isMacNavigatorPlatform: () => false,
}));

import ChatMarkdown from "./ChatMarkdown";
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

async function pickTextColor(label: string, color: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("textbox", { name: `${label} hex value` }).fill(color);
  await userEvent.keyboard("{Escape}");
}

function textColor(selector: string): string {
  return getComputedStyle(document.querySelector(selector)!).color;
}

it("keeps default Markdown colors and applies independent heading/bold overrides with reset", async () => {
  localStorage.setItem("synara:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: "light" }));
  await render(
    <>
      <div id="chat-color-test">
        <ChatMarkdown
          cwd={undefined}
          text={
            "## **Heading**\n\nRegular **emphasis** and `inline code`.\n\n###### Small heading\n\n```js\nconst answer = 42;\n```"
          }
        />
      </div>
      <ThemePackEditor variant="light" />
    </>,
  );
  await expect.poll(() => root.style.getPropertyValue("--chat-bold-color")).toBe("");
  const regular = textColor("#chat-color-test p");
  const muted = textColor("#chat-color-test h6");
  const code = textColor("#chat-color-test code");
  const codeBlock = textColor("#chat-color-test pre");
  expect(textColor("#chat-color-test h2")).toBe(regular);
  expect(textColor("#chat-color-test strong")).toBe(regular);
  expect(page.getByText("Follow theme", { exact: true }).elements()).toHaveLength(2);

  await pickTextColor("Light theme chat headings color", "#2563eb");
  await pickTextColor("Light theme bold text color", "#9a6700");
  await expect.poll(() => textColor("#chat-color-test h2 strong")).toBe("rgb(37, 99, 235)");
  expect(textColor("#chat-color-test h6")).toBe("rgb(37, 99, 235)");
  expect(textColor("#chat-color-test p strong")).toBe("rgb(154, 103, 0)");
  expect(textColor("#chat-color-test p")).toBe(regular);
  expect(textColor("#chat-color-test code")).toBe(code);
  expect(textColor("#chat-color-test pre")).toBe(codeBlock);
  expect(page.getByText("Custom", { exact: true }).elements()).toHaveLength(2);

  await selectLightPreset("Catppuccin");
  expect(root.style.getPropertyValue("--chat-heading-color")).toBe("#2563eb");
  const saved = parseStoredThemeState(localStorage.getItem("synara:theme"));
  expect(saved.chromeThemes.light.chatBoldColor).toBe("#9a6700");
  expect(saved.chromeThemes.dark.chatBoldColor).toBeUndefined();
  await selectLightPreset("Codex");
  await page.getByRole("button", { name: "Reset Light theme chat headings color" }).click();
  await expect.poll(() => textColor("#chat-color-test h2 strong")).toBe(regular);
  expect(textColor("#chat-color-test h6")).toBe(muted);
  expect(textColor("#chat-color-test p strong")).toBe("rgb(154, 103, 0)");
  await page.getByRole("button", { name: "Reset Light theme bold text color" }).click();
  await expect.poll(() => textColor("#chat-color-test p strong")).toBe(regular);
});

it("isolates inactive previews from active custom colors and activates the saved overrides", async () => {
  localStorage.setItem(
    "synara:theme",
    JSON.stringify({
      ...DEFAULT_THEME_STATE,
      mode: "dark",
      chromeThemes: {
        ...DEFAULT_THEME_STATE.chromeThemes,
        dark: {
          ...DEFAULT_THEME_STATE.chromeThemes.dark,
          chatHeadingColor: "#e5c07b",
          chatBoldColor: "#93c5fd",
        },
      },
    }),
  );
  await render(<ThemePackEditor variant="light" />);
  const preview = page.getByRole("img", { name: "Light theme preview: Codex" });
  expect(getComputedStyle(preview.element().querySelector("h3")!).color).toBe("rgb(13, 13, 13)");
  expect(getComputedStyle(preview.element().querySelector("strong")!).color).toBe(
    "rgb(13, 13, 13)",
  );
  await pickTextColor("Light theme bold text color", "#9a6700");
  expect(root.style.getPropertyValue("--chat-bold-color")).toBe("#93c5fd");
  expect(getComputedStyle(preview.element().querySelector("strong")!).color).toBe(
    "rgb(154, 103, 0)",
  );
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect.poll(() => root.style.getPropertyValue("--chat-bold-color")).toBe("#9a6700");
  expect(root.style.getPropertyValue("--chat-heading-color")).toBe("");
});
