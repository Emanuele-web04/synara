import { test, expect, type Page, type TestInfo } from "playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NativeApi } from "@synara/contracts";
import type { EditorDebugStore } from "../src/components/codeEditor/editorDebugStore";

declare global {
  interface Window {
    editorRaceProbe?: { store: EditorDebugStore; restore: () => void };
    editorNavigationProbe?: { targetReads: number; restore: () => void };
  }
}

// These journeys drive the real web client, compiler, native saves and debugger.
// Recovery cases explicitly inject one chunk failure or one native write failure.
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
    for (const label of ["Skip setup", "Not now", "Skip tour", "Dismiss toast"]) {
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
async function beginEditing(page: Page, relativePath: string) {
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
  const input = page.getByRole("textbox", { name: `Edit ${relativePath}`, exact: true });
  // A cold route can finish initializing its pane after the first click. Check
  // the editing result before another click so an already-open editor is kept.
  await expect(async () => {
    await dismissStartupSurfaces(page);
    if (await input.count()) return;
    await editFile.click({ timeout: 5_000 });
    await expect(input).toBeAttached({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}
async function open(page: Page, relativePath = "main.ts") {
  await beginEditing(page, relativePath);
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

test("retries a failed editor import with a fresh document after saving the fallback draft", async ({
  page,
}, info) => {
  const fileName = "retry-recovery.ts";
  const draft = "export const savedFallbackDraft = 2;\n";
  await writeFile(path.join(workspace, fileName), "export const original = 1;\n");
  await seed(page);
  let requests = 0;
  await page.route("**/src/components/codeEditor/MonacoEditorSurface.tsx*", async (route) => {
    if (++requests === 1) await route.abort("failed");
    else await route.continue();
  });
  await beginEditing(page, fileName);
  const fallback = page.getByRole("textbox", { name: `Edit ${fileName}`, exact: true });
  await expect(fallback).toBeVisible();
  await fallback.fill(draft);
  // Retry must flush the native session, even before its autosave timer fires.
  await Promise.all([
    page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame()),
    page.getByRole("button", { name: "Retry", exact: true }).click(),
  ]);
  await expect.poll(() => readFile(path.join(workspace, fileName), "utf8")).toBe(draft);
  // Reload can restore the editing mode or return to the saved file preview.
  const editFile = page.getByRole("button", { name: "Edit file", exact: true });
  await expect
    .poll(async () => {
      await dismissStartupSurfaces(page);
      return (
        (await editFile.isVisible()) || (await page.locator(".monaco-editor").first().isVisible())
      );
    })
    .toBe(true);
  if (await editFile.isVisible()) await editFile.click();
  await editorVisible(page, fileName);
  expect(requests).toBeGreaterThan(1);
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText(
    "savedFallbackDraft",
  );
  await capture(page, info, "after-editor-retry-restores-saved-draft");
});

test("keeps the fallback draft open when saving before Retry fails", async ({ page }, info) => {
  const fileName = "retry-blocked.ts";
  const original = "export const original = 1;\n";
  const draft = "export const unsavedFallbackDraft = 2;\n";
  await writeFile(path.join(workspace, fileName), original);
  await seed(page);
  let requests = 0;
  await page.route("**/src/components/codeEditor/MonacoEditorSurface.tsx*", async (route) => {
    if (++requests === 1) await route.abort("failed");
    else await route.continue();
  });
  await beginEditing(page, fileName);
  await page.evaluate(async () => {
    const modulePath = "/src/nativeApi.ts";
    const { ensureNativeApi } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import("../src/nativeApi");
    const api: NativeApi = ensureNativeApi();
    api.projects.writeFile = async () => {
      throw new Error("QA write blocked");
    };
  });
  const fallback = page.getByRole("textbox", { name: `Edit ${fileName}`, exact: true });
  await fallback.fill(draft);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Could not reload the editor", { exact: true })).toBeVisible();
  await expect(fallback).toHaveValue(draft);
  expect(await readFile(path.join(workspace, fileName), "utf8")).toBe(original);
  expect(requests).toBe(1);
  await capture(page, info, "after-editor-retry-preserves-blocked-draft");
});

test("retains a real debugger pause that arrives before the step acknowledgement", async ({
  page,
}, info) => {
  await writeFile(
    path.join(workspace, "debug-race.js"),
    "let counter = 1;\ncounter += 1;\nsetInterval(() => {}, 100);\n",
  );
  await seed(page);
  await open(page, "debug-race.js");
  await position(page, "counter");
  await page.keyboard.press("F5");
  await page.getByRole("checkbox", { name: "Pause at the first line", exact: true }).check();
  await page.getByRole("button", { name: "Save and debug", exact: true }).click();
  const panel = page.getByRole("region", { name: "Debug session", exact: true });
  try {
    await expect(panel).toContainText("Paused", { timeout: 60_000 });
    await page.evaluate(async () => {
      const runtime = "/src/components/codeEditor/editorRuntime.ts";
      const models = "/src/components/codeEditor/editorModels.ts";
      const stores = "/src/components/codeEditor/editorDebugStore.ts";
      const native = "/src/nativeApi.ts";
      const { monaco } = (await import(
        /* @vite-ignore */ runtime
      )) as typeof import("../src/components/codeEditor/editorRuntime");
      const { editorEntry } = (await import(
        /* @vite-ignore */ models
      )) as typeof import("../src/components/codeEditor/editorModels");
      const { getEditorDebugStore } = (await import(
        /* @vite-ignore */ stores
      )) as typeof import("../src/components/codeEditor/editorDebugStore");
      const { ensureNativeApi } = (await import(
        /* @vite-ignore */ native
      )) as typeof import("../src/nativeApi");
      const model = monaco.editor
        .getEditors()
        .find((editor) => editor.getModel()?.uri.scheme === "synara-workspace")
        ?.getModel();
      const entry = model && editorEntry(model);
      if (!entry?.cwd) throw new Error("Missing workspace editor.");
      const api = ensureNativeApi();
      const action = api.editor.debugAction;
      window.editorRaceProbe = {
        store: getEditorDebugStore(entry.client, entry.cwd),
        restore: () => {
          api.editor.debugAction = action;
        },
      };
      // Delay only delivery of the real RPC response; the poll events remain real.
      api.editor.debugAction = async (input) => {
        const result = await action(input);
        if (input.action === "next") await new Promise((resolve) => setTimeout(resolve, 1_500));
        return result;
      };
    });
    const snapshot = () => page.evaluate(() => window.editorRaceProbe!.store.getSnapshot());
    const pauseVersion = (await snapshot()).pauseVersion;
    await panel.getByRole("button", { name: /^Step over/ }).click();
    await expect.poll(async () => (await snapshot()).pauseVersion).toBeGreaterThan(pauseVersion);
    await expect.poll(async () => (await snapshot()).busy).toBe(false);
    expect((await snapshot()).phase).toBe("paused");
    expect((await snapshot()).frames.length).toBeGreaterThan(0);
    expect((await snapshot()).scopes.length).toBeGreaterThan(0);
    await capture(page, info, "after-late-step-preserves-real-pause");
  } finally {
    await page.evaluate(async () => {
      window.editorRaceProbe?.restore();
      await window.editorRaceProbe?.store.stop();
      delete window.editorRaceProbe;
    });
  }
});

test("does not retain a definition reveal after a blocked navigation", async ({ page }, info) => {
  const targetFile = "navigation-target.ts";
  const originFile = "navigation-origin.ts";
  const target = "\n\n\nexport function navigationTarget() { return 42; }\n";
  const origin = 'import { navigationTarget } from "./navigation-target";\nnavigationTarget();\n';
  await writeFile(path.join(workspace, targetFile), target);
  await writeFile(path.join(workspace, originFile), origin);
  await seed(page);
  await open(page, targetFile);
  await page.keyboard.press("ControlOrMeta+Home");
  await open(page, originFile);
  await page.evaluate(async (targetFile) => {
    const modulePath = "/src/nativeApi.ts";
    const { ensureNativeApi } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import("../src/nativeApi");
    const api = ensureNativeApi();
    const write = api.projects.writeFile;
    const read = api.projects.readFile;
    window.editorNavigationProbe = {
      targetReads: 0,
      restore: () => {
        api.projects.writeFile = write;
        api.projects.readFile = read;
      },
    };
    api.projects.writeFile = async () => {
      throw new Error("Navigation save blocked");
    };
    api.projects.readFile = async (input) => {
      const result = await read(input);
      if (input.relativePath === targetFile) window.editorNavigationProbe!.targetReads++;
      return result;
    };
  }, targetFile);
  try {
    await position(page, "navigationTarget();", 1);
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    await expect(page.getByText("Navigation save blocked", { exact: true })).toBeVisible();
    await position(page, "navigationTarget();", 1);
    await page.keyboard.press("F12");
    // A definition RPC can finish before its target is loaded. Observe the
    // successful real file read and let its UI microtasks settle before leaving.
    await expect
      .poll(() => page.evaluate(() => window.editorNavigationProbe!.targetReads))
      .toBeGreaterThan(0);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(page.getByText(/No definition found/)).toHaveCount(0);
    await editorVisible(page, originFile);
    await page.evaluate(() => window.editorNavigationProbe!.restore());
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => readFile(path.join(workspace, originFile), "utf8"))
      .toBe(origin.replace("navigationTarget();", "navigationTarget(); "));
    await page.getByRole("button", { name: targetFile, exact: true }).click();
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    await editorVisible(page, targetFile);
    await expect
      .poll(() =>
        page.evaluate(async (file) => {
          const modulePath = "/src/components/codeEditor/editorRuntime.ts";
          const { monaco } = (await import(
            /* @vite-ignore */ modulePath
          )) as typeof import("../src/components/codeEditor/editorRuntime");
          return monaco.editor
            .getEditors()
            .find((editor) => editor.getModel()?.uri.path.endsWith("/" + file))
            ?.getPosition()?.lineNumber;
        }, targetFile),
      )
      .toBe(1);
    await capture(page, info, "after-blocked-definition-keeps-manual-position");
  } finally {
    await page.evaluate(() => {
      window.editorNavigationProbe?.restore();
      delete window.editorNavigationProbe;
    });
  }
});
