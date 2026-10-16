import { test, expect } from "playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { seedEditorProject } from "./editorAcceptanceFixture";
import { capture } from "./extensionAcceptanceControls";

let cwd: string;
const contents =
  'export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n\nconst greeting: number = greet("Synara");\nconsole.log(greeting);\n';
test.beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "synara-editor-tools-"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src/app.ts"), contents);
  await writeFile(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" }, include: ["src"] }),
  );
  execFileSync("git", ["init", "-b", "main", cwd]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Editor tools acceptance",
    "-c",
    "user.email=editor-test@example.invalid",
    "commit",
    "-m",
    "Isolated editor tools fixture",
  ]);
});
test.afterAll(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

test("inner rail opens real editor tools without replacing documents or starting extensions", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const threadId = await seedEditorProject(page, cwd);
  await page.goto(`/${threadId}?view=editor&editorFilePath=src%2Fapp.ts`);
  await page.getByRole("button", { name: "Edit file", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edit src/app.ts", exact: true });
  await expect(editor).toBeAttached();
  const rail = page.getByRole("navigation", { name: "Editor activity bar", exact: true });
  await expect(rail).toBeVisible();
  if (process.env.SYNARA_EDITOR_RAIL_BASELINE === "1") {
    await expect(rail.getByRole("button")).toHaveCount(3);
    await capture(page, info, "before-native-editor-three-button-rail");
    return;
  }
  await expect(rail.getByRole("button")).toHaveCount(8);
  const outline = rail.getByRole("button", { name: "Outline", exact: true });
  await expect(outline).toBeEnabled();
  await expect(page.getByRole("button", { name: "Problems", exact: true })).toBeEnabled();
  await capture(page, info, "after-native-editor-tools-rail");

  await outline.focus();
  await page.keyboard.press("Enter");
  // Command pickers expose their title through aria-label, not visible heading text.
  await expect(
    page.getByRole("dialog", { name: "Go to symbol in file", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option").filter({ has: page.getByText("greet", { exact: true }) }),
  ).toBeVisible();
  // Modal isolation correctly removes the underlying rail from the accessibility tree.
  await expect(
    page.locator('nav[aria-label="Editor activity bar"] button[aria-label="Outline"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await capture(page, info, "after-outline-native-picker");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect
    .poll(() => page.locator('.monaco-editor [class*="squiggly-error"]').count())
    .toBeGreaterThan(0);
  await rail.getByRole("button", { name: "Problems", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Problems in this file", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: /not assignable/ }).first()).toBeVisible();
  await capture(page, info, "after-problems-native-diagnostics");
  await page.keyboard.press("Escape");

  await rail.getByRole("button", { name: "Run and debug", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Run and debug", exact: true })).toBeVisible();
  await capture(page, info, "after-debug-native-actions");
  await page.getByRole("option", { name: /Start debugging/ }).click();
  const debugDialog = page.getByRole("dialog", { name: "Debug a Node.js program", exact: true });
  await expect(debugDialog).toBeVisible();
  await debugDialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await rail.getByRole("button", { name: "Editor commands", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Editor commands", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Format document", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1024, height: 720 });
  await expect(rail.getByRole("button", { name: "Editor commands", exact: true })).toBeInViewport();
  await capture(page, info, "after-compact-native-editor-rail");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await rail.getByRole("button", { name: "Editor extensions", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Extensions", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Manage extensions", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: /Start approved extensions/ })).toBeVisible();
  await capture(page, info, "after-extensions-native-actions");
  await page.getByRole("option", { name: "Manage extensions", exact: true }).click();
  await expect(page).toHaveURL(/settings\?section=extensions/);
  await expect(page.getByRole("textbox", { name: "Search Open VSX" })).toBeVisible();
  await capture(page, info, "after-rail-opens-existing-extension-settings");
  expect(await readFile(path.join(cwd, "src/app.ts"), "utf8")).toBe(contents);
  expect(errors).toEqual([]);
});
