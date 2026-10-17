import { test, expect, type Page, type TestInfo } from "playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// This drives the real web client, real server RPCs, real compiler, native save path,
// and real debugger. No service worker, response interception, or mocked native API.
let workspace: string;
let threadId: string;
// One project per workspace: the server rejects a second registration of the same root.
let projectId: string | undefined;
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

// The import announcement, feature tour and update toasts can appear on any
// route change; clear whichever is up so no modal blocks the journey.
async function dismissStartupSurfaces(page: Page) {
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
}
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
  await dismissStartupSurfaces(page);
  await expect(welcome).toHaveCount(0);
  const seeded = await page.evaluate(
    async ({ cwd, existingProjectId }) => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      const api = ensureNativeApi();
      const now = new Date().toISOString();
      const projectId = existingProjectId ?? crypto.randomUUID();
      const threadId = crypto.randomUUID();
      if (!existingProjectId)
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
      return { projectId, threadId };
    },
    { cwd: workspace, existingProjectId: projectId },
  );
  projectId = seeded.projectId;
  threadId = seeded.threadId;
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
  // A startup surface (feature tour) can open over the route; role queries skip
  // the page behind a modal, so clear it before looking for the preview control.
  const editFile = page.getByRole("button", { name: "Edit file", exact: true });
  for (let attempt = 0; attempt < 40; attempt++) {
    await dismissStartupSurfaces(page);
    if (await editFile.isVisible().catch(() => false)) break;
    await page.waitForTimeout(500);
  }
  // File navigation opens Synara's read-only preview; enter editing via its native control.
  await editFile.click();
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
  // The app fills the viewport, and a full-page capture resizes it, which
  // dismisses the open command picker before the next step clicks into it.
  await page.screenshot({ path: target });
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
  // Inlay hints come from the compiler (the inferred variable type); bracket
  // pairs take the Shiki theme's colours.
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("message: string");
  await expect(
    page.locator('.monaco-editor .view-lines [class*="bracket-highlighting-"]').first(),
  ).toBeVisible();
  await capture(page, info, "after-inlay-hints-and-bracket-pairs");

  await position(page, "greet(person", 1);
  await page.keyboard.press("Shift+F12");
  const peek = page.locator(".monaco-editor .reference-zone-widget").first();
  await expect(peek).toBeVisible();
  await expect(peek).toContainText("greeting.ts");
  await capture(page, info, "after-peek-references");
  await page.keyboard.press("Escape");
  await expect(peek).toBeHidden();

  await command(page, "Go to line");
  await page.getByRole("combobox", { name: "Go to line", exact: true }).fill("3");
  // The row's accessible name carries its detail ("of 11 lines"); match the label.
  const gotoLineRow = page.getByRole("option", { name: /^Go to line 3\b/ });
  await expect(gotoLineRow).toBeVisible();
  await capture(page, info, "after-go-to-line");
  await gotoLineRow.click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const modulePath = "/src/components/codeEditor/editorRuntime.ts";
        const { monaco } = await import(/* @vite-ignore */ modulePath);
        return monaco.editor
          .getEditors()
          .find(
            (candidate: { getModel(): { uri: { scheme: string } } | null }) =>
              candidate.getModel()?.uri.scheme === "synara-workspace",
          )
          ?.getPosition()?.lineNumber;
      }),
    )
    .toBe(3);

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
  // The lightbulb marks the fixable line; the quick-fix menu is the engine's own.
  await expect(page.locator(".monaco-editor .lightBulbWidget").first()).toBeVisible();
  await command(page, "Quick fix");
  await expect(page.locator(".action-widget").first()).toBeVisible();
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
  // The dialog focuses and selects its field on the next frame; type after that.
  // ArrowRight collapses the selection to the end on every platform (End does not on macOS).
  await expect(name).toBeFocused();
  await page.keyboard.press("ArrowRight");
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

test("edits a changed file as a diff with collapsed regions and symbol breadcrumbs", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Earlier journeys edit main.ts; one change against the committed baseline
  // leaves a long unchanged head for the diff to collapse.
  await writeFile(path.join(workspace, "main.ts"), source.replace('"Ada"', '"Grace"'));
  await seed(page);
  // Land on the file preview (the settled route the other journeys use), then
  // switch the rail to the Diff pane; each changed file's header carries the
  // actions menu that opens the editable diff.
  await page.goto(`/${threadId}?view=editor&editorFilePath=${encodeURIComponent("main.ts")}`);
  const previewEdit = page.getByRole("button", { name: "Edit file", exact: true });
  for (let attempt = 0; attempt < 40; attempt++) {
    await dismissStartupSurfaces(page);
    if (await previewEdit.isVisible().catch(() => false)) break;
    await page.waitForTimeout(500);
  }
  await page.getByRole("button", { name: "Diff", exact: true }).click();
  const actions = page.getByRole("button", { name: "File actions", exact: true });
  await expect.poll(() => actions.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  const mainHeader = page
    .locator("[data-diff-file-header], [data-diffs-header], [data-file-info]")
    .filter({ hasText: /\bmain\.ts\b/ })
    .first();
  await dismissStartupSurfaces(page);
  await mainHeader.getByRole("button", { name: "File actions", exact: true }).click();
  // Toasts can land over the menu; activate the item from the keyboard.
  const editFile = page.getByRole("menuitem", { name: "Edit file", exact: true });
  await expect(editFile).toBeVisible();
  await editFile.focus();
  await editFile.press("Enter");
  await editorVisible(page, "main.ts");
  // The unchanged head of the file collapses behind a bar whose breadcrumb
  // names the enclosing symbol from the compiler's document symbols.
  // The bar's container has no box of its own; assert its visible label and crumb.
  const diff = page.locator(".monaco-diff-editor").first();
  await expect(diff.getByText(/\d+ hidden lines/).first()).toBeVisible();
  await expect(
    diff.locator(".diff-hidden-lines .breadcrumb-item").filter({ hasText: "Person" }).first(),
  ).toBeVisible();
  await capture(page, info, "after-diff-breadcrumbs");
  expect(errors).toEqual([]);
});
