import { test, expect } from "playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedEditorProject } from "./editorAcceptanceFixture";
import { capture, command, bridgePhase } from "./extensionAcceptanceControls";

let cwd: string;
test.beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "synara-debug-ui-"));
  await mkdir(path.join(cwd, ".vscode"));
  await writeFile(
    path.join(cwd, "fixture.c"),
    "int main(void) {\n  volatile int answer = 42;\n  return answer == 42 ? 0 : 1;\n}\n",
  );
  execFileSync("cc", ["-g", "-O0", path.join(cwd, "fixture.c"), "-o", path.join(cwd, "fixture")], {
    timeout: 15_000,
  });
  await writeFile(
    path.join(cwd, ".vscode/launch.json"),
    JSON.stringify({
      version: "0.2.0",
      configurations: [
        {
          name: "Native Debug fixture",
          type: "gdb",
          request: "launch",
          target: "${workspaceFolder}/fixture",
          cwd: "${workspaceFolder}",
          stopAtEntry: true,
          valuesFormatting: "parseText",
        },
      ],
    }),
  );
  execFileSync("git", ["init", "-b", "main", cwd]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Debug acceptance",
    "-c",
    "user.email=debug-test@example.invalid",
    "commit",
    "-m",
    "Isolated debugger fixture",
  ]);
});
test.afterAll(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

test("real debugger extension uses the existing Synara debug panel", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const threadId = await seedEditorProject(page, cwd);
  try {
    await page.goto("/settings?section=extensions");
    await page.getByRole("textbox", { name: "Search Open VSX" }).fill("webfreak.debug");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const result = page.getByTestId("extension-card").filter({ hasText: "webfreak.debug" });
    await expect(result).toHaveCount(1, { timeout: 35_000 });
    await result.getByRole("button", { name: "Install", exact: true }).click();
    await page.getByRole("radio", { name: /^Installed/ }).click();
    const installed = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Installed extensions", exact: true }) })
      .locator('[data-slot="settings-row"]')
      .filter({ hasText: "webfreak.debug" });
    await expect(installed.getByRole("button", { name: "Enable", exact: true })).toBeEnabled({
      timeout: 90_000,
    });
    await installed.getByRole("button", { name: "Enable", exact: true }).click();
    const approval = page.getByRole("alertdialog");
    await approval.getByRole("button", { name: "Enable approved versions" }).click();
    await expect(approval).not.toBeVisible();
    await page.getByRole("radio", { name: "Permissions", exact: true }).click();
    await page.getByRole("textbox", { name: "Workspace directory" }).fill(cwd);
    await page.getByRole("button", { name: "Trust workspace", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Trust workspace", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
    await capture(page, info, "installed-real-native-debug-extension");
    await page.goto(`/${threadId}?view=editor&editorFilePath=fixture.c`);
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Edit fixture.c", exact: true })).toBeAttached();
    await capture(page, info, "before-extension-debugger-native-editor");
    await command(page, "Start approved extensions");
    await expect.poll(() => bridgePhase(page), { timeout: 45_000 }).toBe("running");
    await command(page, "Start extension debugger");
    await expect(page.getByRole("option", { name: /Native Debug fixture/ })).toBeVisible();
    await capture(page, info, "native-extension-debug-configuration-picker");
    await page.getByRole("option", { name: /Native Debug fixture/ }).click();
    const panel = page.getByRole("region", { name: "Debug session" });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Paused", exact: true })).toBeVisible();
    await expect(panel).toContainText("fixture.c");
    await capture(page, info, "after-real-extension-debugger-native-stack");
    await panel.getByRole("button", { name: "Stop debugging (Shift+F5)", exact: true }).click();
    await expect(panel).toContainText("Debug session ended");
    await expect.poll(() => bridgePhase(page)).toBe("stopped");
    await capture(page, info, "after-extension-debugger-cleanup");
    expect(errors).toEqual([]);
  } catch (error) {
    console.error(
      "NATIVE_DEBUG_UI_FAILURE",
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
        (entry: { id: string; version: string }) => entry.id === "webfreak.debug",
      );
      if (installed)
        await extensions({ operation: "remove", id: installed.id, version: installed.version });
    }, cwd);
  }
});
