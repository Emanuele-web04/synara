import { seedEditorProject } from "./editorAcceptanceFixture";
import { test, expect, type Page, type TestInfo } from "playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// This drives the real web client, real server RPCs, real compiler, native save path,
// and real debugger. No service worker, response interception, or mocked native API.
let workspace: string;
let threadId: string;
const source = `import { greet } from "./greeting";

interface Person {
  name: string;
  age: number;
}

const person: Person = { name: "Ada", age: 37 };
const message = greet(person.name);
console.log(message);
`;
test.beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "synara-editor-project-"));
  await writeFile(
    path.join(workspace, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }),
  );
  await writeFile(
    path.join(workspace, "greeting.ts"),
    "/** Say hello to a developer. */\nexport function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n",
  );
  await writeFile(path.join(workspace, "main.ts"), source);
  await writeFile(
    path.join(workspace, "debug.js"),
    "function increment(value) {\n  return value + 1;\n}\nconst answer = increment(41);\nconsole.log(answer);\nsetInterval(() => {}, 100);\n",
  );
  execFileSync("git", ["init", "-b", "main", workspace]);
  execFileSync("git", ["-C", workspace, "config", "diff.mnemonicPrefix", "false"]);
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", [
    "-C",
    workspace,
    "-c",
    "user.name=Editor acceptance",
    "-c",
    "user.email=editor-test@example.invalid",
    "commit",
    "-m",
    "Fixture baseline",
  ]);
  await writeFile(path.join(workspace, "main.ts"), source.replace('"Ada"', '"Grace"'));
});
test.afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

async function seed(page: Page) {
  threadId = await seedEditorProject(page, workspace);
}
async function editorVisible(page: Page, relativePath: string) {
  // Monaco's native EditContext input has no width until it receives focus.
  // Assert the real visible editor, with its accessible input attached inside it.
  const input = page.getByRole("textbox", { name: `Edit ${relativePath}`, exact: true });
  await expect(input).toBeAttached();
  await expect(page.locator(".monaco-editor").filter({ has: input })).toBeVisible();
}
async function open(page: Page, relativePath = "main.ts") {
  await page.goto(`/${threadId}?view=editor&editorFilePath=${encodeURIComponent(relativePath)}`);
  // File navigation opens Synara's read-only preview; enter editing via its native control.
  await page.getByRole("button", { name: "Edit file", exact: true }).click();
  await editorVisible(page, relativePath);
}
async function position(page: Page, text: string, delta = 0) {
  await page.evaluate(
    async ({ text, delta }) => {
      const modulePath = "/src/components/codeEditor/editorRuntime.ts";
      const { monaco } = await import(/* @vite-ignore */ modulePath);
      const editor = monaco.editor
        .getEditors()
        .find(
          (candidate: { getModel(): { uri: { scheme: string } } | null }) =>
            candidate.getModel()?.uri.scheme === "synara-workspace",
        );
      if (!editor) throw new Error("The real workspace editor did not mount.");
      const model = editor.getModel();
      const offset = model.getValue().indexOf(text);
      if (offset < 0) throw new Error(`Missing fixture text: ${text}`);
      editor.setPosition(model.getPositionAt(offset + delta));
      editor.focus();
    },
    { text, delta },
  );
}
async function capture(page: Page, info: TestInfo, name: string) {
  const target = info.outputPath(`${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  await info.attach(name, { path: target, contentType: "image/png" });
}
async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.getByRole("combobox", { name: "Editor commands" }).fill(name);
  await page.getByRole("option", { name, exact: false }).click();
}

test("native editor intelligence, guarded persistence, navigation, and debugging", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(page);
  await open(page);
  await capture(page, info, "after-files-editor-chat");

  await position(page, "person.name", "person.".length);
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".suggest-widget.visible")).toBeVisible();
  await expect(page.locator(".suggest-widget.visible")).toContainText("name");
  await capture(page, info, "after-real-intellisense");
  await page.keyboard.press("Escape");

  await position(page, "greet(person", 1);
  await page.keyboard.press("F12");
  await editorVisible(page, "greeting.ts");
  await capture(page, info, "after-definition-navigation");

  await open(page);
  await position(page, "person.name", "person.".length);
  await page.keyboard.press("End");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText('const broken: number = "type error";\n"hello".toUppercase();\n');
  await expect(page.getByRole("button", { name: "Show problems in file" })).toBeVisible();
  await page.getByRole("button", { name: "Show problems in file" }).click();
  await expect(page.getByRole("dialog")).toContainText("number");
  await capture(page, info, "after-real-diagnostics");
  await page.keyboard.press("Escape");
  await position(page, "toUppercase", 2);
  await command(page, "Quick fixes and refactorings");
  await expect(page.getByRole("option", { name: /toUpperCase/ })).toBeVisible();
  await capture(page, info, "after-native-quick-fix");
  await page
    .getByRole("option", { name: /toUpperCase/ })
    .first()
    .click();
  await expect
    .poll(async () => await readFile(path.join(workspace, "main.ts"), "utf8"))
    .toContain("toUpperCase()");

  await open(page, "debug.js");
  await position(page, "const answer");
  await page.keyboard.press("F9");
  await page.keyboard.press("F5");
  await expect(page.getByRole("dialog")).toContainText("Only start code you trust");
  await page.getByRole("button", { name: "Save and debug", exact: true }).click();
  const panel = page.getByRole("region", { name: "Debug session" });
  await expect(panel).toContainText("Paused", { timeout: 60_000 });
  await capture(page, info, "after-real-debugging");
  await panel.getByRole("button", { name: "Step into (F11)", exact: true }).click();
  await expect(panel).toContainText("increment");
  await panel.getByRole("radio", { name: "Watch", exact: true }).click();
  await panel.getByRole("textbox", { name: "Watch expression" }).fill("value + 1");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel).toContainText("42");
  await capture(page, info, "after-real-watch-expression");
  await panel.getByRole("button", { name: "Stop debugging (Shift+F5)", exact: true }).click();
  await expect(panel).toContainText("ended");
  await capture(page, info, "after-debug-cleanup");
  expect(errors).toEqual([]);
});

test("renames an exported symbol after editing the dialog name", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(page);
  await open(page, "greeting.ts");
  await position(page, "greet", 1);
  await page.keyboard.press("F2");
  const name = page.getByRole("textbox", { name: "New symbol name", exact: true });
  await expect(name).toHaveValue("greet");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(name).toHaveValue("gre");
  await page.keyboard.insertText("etRenamed");
  await expect(name).toHaveValue("greetRenamed");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Rename symbol", exact: true })).toHaveCount(0);
  await editorVisible(page, "greeting.ts");
  await expect
    .poll(() => readFile(path.join(workspace, "main.ts"), "utf8"))
    .toContain('import { greetRenamed } from "./greeting"');
  await expect
    .poll(() => readFile(path.join(workspace, "main.ts"), "utf8"))
    .toContain("greetRenamed(person.name)");
  await expect
    .poll(() => readFile(path.join(workspace, "greeting.ts"), "utf8"))
    .toContain("export function greetRenamed(");
  expect(errors).toEqual([]);
});
