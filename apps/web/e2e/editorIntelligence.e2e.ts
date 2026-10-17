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
test.beforeAll(async () => {
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
test.afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

async function seed(page: Page) {
  await page.goto("/");
  // Fail at bootstrap rather than sending a command into a disconnected transport.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const modulePath = "/src/nativeApi.ts";
          const { ensureNativeApi, readNativeApiServerCapability } = await import(
            /* @vite-ignore */ modulePath
          );
          ensureNativeApi();
          return readNativeApiServerCapability("rpc.typed-errors");
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  // Startup surfaces show once per server home and in sequence (welcome tour,
  // import announcement, feature tour); dismiss whichever appears so no modal
  // blocks the journey. Toasts also carry the dialog role and may arrive any time.
  const welcome = page.getByRole("dialog", { name: "Welcome to Synara", exact: true });
  const skipTour = welcome.getByRole("button", { name: "Skip setup", exact: true });
  await skipTour
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => skipTour.click())
    .catch(() => undefined);
  for (let round = 0; round < 6; round++) {
    let dismissed = false;
    for (const label of ["Not now", "Skip tour", "Dismiss toast"]) {
      for (const button of await page.getByRole("button", { name: label, exact: true }).all()) {
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 2_000 }).catch(() => undefined);
          dismissed = true;
        }
      }
    }
    if (!dismissed) break;
    await page.waitForTimeout(400);
  }
  await expect(welcome).toHaveCount(0);
  await page
    .evaluate(async (cwd) => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      const api = ensureNativeApi();
      const now = new Date().toISOString();
      const projectId = crypto.randomUUID();
      const threadId = crypto.randomUUID();
      await api.orchestration.dispatchCommand({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId,
        title: "Editor acceptance",
        workspaceRoot: cwd,
        createdAt: now,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: crypto.randomUUID(),
        threadId,
        projectId,
        title: "Native editor intelligence",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: now,
      });
      // No turn is submitted: model metadata does not start a provider or send project data.
      return threadId;
    }, workspace)
    .then((id) => {
      threadId = id;
    });
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
  await expect(page.getByRole("button", { name: "Show problems", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show problems", exact: true }).click();
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
  await panel.getByRole("button", { name: /^Step into/ }).click();
  await expect(panel).toContainText("increment");
  await panel.getByRole("radio", { name: "Watch", exact: true }).click();
  await panel.getByRole("textbox", { name: "Watch expression" }).fill("value + 1");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel).toContainText("42");
  await capture(page, info, "after-real-watch-expression");
  await panel.getByRole("button", { name: /^Stop debugging/ }).click();
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
  const name = page.getByRole("textbox", { name: "Rename symbol", exact: true });
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
