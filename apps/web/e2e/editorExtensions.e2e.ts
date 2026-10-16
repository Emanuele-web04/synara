import { test, expect } from "playwright/test";
import { capture, command, bridgePhase } from "./extensionAcceptanceControls";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedEditorProject } from "./editorAcceptanceFixture";

// Real app, real registry, actual VSIX, production sandbox and native writer.
// There is no response interception, mock extension or replacement native API.
let cwd: string;
const before = "const answer={value:42}";
const after = "const answer = { value: 42 };\n";
test.beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "synara-extensions-ui-"));
  await writeFile(path.join(cwd, "example.js"), before);
  execFileSync("git", ["init", "-b", "main", cwd]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Extension acceptance",
    "-c",
    "user.email=extension-test@example.invalid",
    "commit",
    "-m",
    "Isolated extension fixture",
  ]);
});
test.afterAll(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

test("native settings, actual extension install, sandbox activation, formatting and undo", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const threadId = await seedEditorProject(page, cwd);
  try {
    await page.goto("/settings?section=extensions");
    await page.getByRole("radio", { name: /^Installed/ }).click();
    await expect(page.getByText("No editor extensions installed.", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "Marketplace", exact: true }).click();
    await capture(page, info, "before-install-native-extension-settings");
    await page.getByRole("textbox", { name: "Search Open VSX" }).fill("esbenp.prettier-vscode");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const result = page.getByTestId("extension-card").filter({ hasText: "esbenp.prettier-vscode" });
    await expect(result).toHaveCount(1, { timeout: 35_000 });
    await expect(result.getByRole("button", { name: "Install", exact: true })).toBeVisible();
    await capture(page, info, "after-real-open-vsx-search");
    await result.getByRole("button", { name: "Install", exact: true }).click();
    await page.getByRole("radio", { name: /^Installed/ }).click();
    const installed = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Installed extensions", exact: true }) });
    await expect(installed).toContainText("esbenp.prettier-vscode", { timeout: 90_000 });
    await expect(installed.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
    await capture(page, info, "after-vsix-validation-installed-disabled");
    await installed.getByRole("button", { name: "Enable", exact: true }).click();
    const approval = page.getByRole("alertdialog");
    await expect(approval).toContainText("SHA-256");
    await capture(page, info, "after-explicit-extension-code-consent");
    await approval.getByRole("button", { name: "Enable approved versions" }).click();
    await expect(installed.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
    await expect(approval).not.toBeVisible();
    await page.getByRole("radio", { name: "Permissions", exact: true }).click();
    await page.getByRole("textbox", { name: "Workspace directory" }).fill(cwd);
    await page.getByRole("button", { name: "Trust workspace", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Trust workspace", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Revoke trust", exact: true })).toBeVisible();
    await capture(page, info, "after-installed-extension-and-workspace-trust");

    await page.goto(`/${threadId}?view=editor&editorFilePath=example.js`);
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Edit example.js", exact: true });
    await expect(input).toBeAttached();
    await expect(page.locator(".monaco-editor").filter({ has: input })).toBeVisible();
    await command(page, "Start approved extensions");
    await expect.poll(() => bridgePhase(page), { timeout: 45_000 }).toBe("running");
    await capture(page, info, "before-format-real-synara-editor");
    await command(page, "Format with extension");
    await expect(page.getByRole("dialog")).toContainText("Prettier");
    await capture(page, info, "after-real-prettier-provider-in-native-picker");
    await page.getByRole("option", { name: /Prettier/ }).click();
    await expect.poll(() => readFile(path.join(cwd, "example.js"), "utf8")).toBe(after);
    await capture(page, info, "after-prettier-format-native-save");
    await command(page, "Undo");
    await expect.poll(() => readFile(path.join(cwd, "example.js"), "utf8")).toBe(before);
    await command(page, "Redo");
    await expect.poll(() => readFile(path.join(cwd, "example.js"), "utf8")).toBe(after);
    await command(page, "Stop extensions");
    await expect.poll(() => bridgePhase(page)).toBe("stopped");
    await capture(page, info, "after-extension-cleanup-native-editor-retained");
    const evidence = await page.evaluate(async () => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      const state = await ensureNativeApi().editor.extensions({ operation: "list" });
      return {
        apiVersion: state.apiVersion,
        runtime: state.runtime,
        extensions: state.extensions.map(
          (entry: { id: string; version: string; digest: string }) => ({
            id: entry.id,
            version: entry.version,
            digest: entry.digest,
          }),
        ),
      };
    });
    await info.attach("actual-extension-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  } catch (error) {
    console.error(
      "NATIVE_EXTENSION_UI_FAILURE",
      (await page.locator("body").innerText()).slice(-16_000),
    );
    throw error;
  } finally {
    await page.evaluate(async (workspace) => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      await ensureNativeApi().editor.extensions({
        operation: "setTrust",
        cwd: workspace,
        trusted: false,
      });
      // Remove only this test's package from the isolated acceptance server.
      // Test files share that server, not the user's production state.
      const extensions = ensureNativeApi().editor.extensions;
      const state = await extensions({ operation: "list" });
      const installed = state.extensions.find(
        (entry: { id: string; version: string }) => entry.id === "esbenp.prettier-vscode",
      );
      if (installed)
        await extensions({ operation: "remove", id: installed.id, version: installed.version });
    }, cwd);
  }
});
