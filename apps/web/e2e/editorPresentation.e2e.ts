import { test, expect } from "playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { seedEditorProject } from "./editorAcceptanceFixture";
import { capture, command } from "./extensionAcceptanceControls";

const baseline = process.env.SYNARA_EDITOR_POLISH_BASELINE === "1";
for (const appearance of ["light", "dark"] as const) {
  test(`native scrollbar and preview/editor continuity (${appearance})`, async ({ page }, info) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "synara-presentation-"));
    const filename = "presentation.ts";
    const contents = Array.from(
      { length: 420 },
      (_, index) => `export const line${index + 1} = "${"readable workspace content ".repeat(8)}";`,
    ).join("\n");
    await writeFile(path.join(cwd, filename), contents);
    execFileSync("git", ["init", "-b", "main", cwd]);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.emulateMedia({
        colorScheme: appearance,
        reducedMotion: appearance === "dark" ? "reduce" : "no-preference",
      });
      const thread = await seedEditorProject(page, cwd);
      await page.goto(`/${thread}?view=editor&editorFilePath=${filename}`);
      const viewer = page.locator(".editor-file-viewer:visible").first();
      await expect(viewer.locator(".line").nth(119)).toBeAttached();
      await viewer.evaluate((container) => {
        const code = container.querySelector("pre code")!;
        const line = code.querySelectorAll(".line")[119]!;
        container.scrollTop +=
          line.getBoundingClientRect().top - container.getBoundingClientRect().top + 1;
        container.scrollLeft = 160;
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(line);
        selection.removeAllRanges();
        selection.addRange(range);
      });
      const selectedText = await page.evaluate(() => window.getSelection()?.toString().trim());
      await capture(page, info, `${baseline ? "before" : "after"}-${appearance}-read-only`);
      await page.getByRole("button", { name: "Edit file", exact: true }).click();
      const input = page.getByRole("textbox", { name: `Edit ${filename}`, exact: true });
      await expect(input).toBeAttached();
      const editorState = () =>
        page.evaluate(async (filename) => {
          const modulePath = "/src/components/codeEditor/editorRuntime.ts";
          const { monaco } = await import(/* @vite-ignore */ modulePath);
          const editor = monaco.editor
            .getEditors()
            .find(
              (entry: { getModel(): { uri: { scheme: string; path: string } } | null }) =>
                entry.getModel()?.uri.scheme === "synara-workspace" &&
                entry.getModel()?.uri.path.endsWith(`/${filename}`),
            );
          if (!editor) return null;
          return {
            top: editor.getScrollTop(),
            expectedTop: editor.getTopForLineNumber(120),
            left: editor.getScrollLeft(),
            selected: editor.getModel().getValueInRange(editor.getSelection()).trim(),
            focused: editor.hasTextFocus(),
            text: editor.getValue(),
            editorCount: monaco.editor
              .getEditors()
              .filter(
                (entry: { getModel(): { uri: { scheme: string } } | null }) =>
                  entry.getModel()?.uri.scheme === "synara-workspace",
              ).length,
          };
        }, filename);
      await expect.poll(async () => (await editorState())?.text).toBe(contents);
      if (!baseline) {
        await expect
          .poll(async () => {
            const state = await editorState();
            return state ? Math.abs(state.top - state.expectedTop) : Infinity;
          })
          .toBeLessThan(3);
        expect((await editorState())?.left).toBe(160);
        expect((await editorState())?.selected).toBe(selectedText);
        expect((await editorState())?.focused).toBe(true);
        expect((await editorState())?.editorCount).toBe(1);
      }
      const surface = page.locator(".synara-code-editor .monaco-editor").filter({ has: input });
      await surface.hover();
      const slider = surface
        .locator(".monaco-scrollable-element > .scrollbar.vertical > .slider")
        .first();
      await expect(slider).toBeAttached();
      if (!baseline) await expect(slider).toHaveCSS("border-radius", "999px");
      await capture(page, info, `${baseline ? "before" : "after"}-${appearance}-editor-scrollbar`);
      if (baseline) return;
      await page.evaluate(async () => {
        const modulePath = "/src/components/codeEditor/editorRuntime.ts";
        const { monaco } = await import(/* @vite-ignore */ modulePath);
        const editor = monaco.editor
          .getEditors()
          .find(
            (entry: { getModel(): { uri: { scheme: string } } | null }) =>
              entry.getModel()?.uri.scheme === "synara-workspace",
          );
        editor.setScrollPosition({ scrollTop: editor.getTopForLineNumber(240), scrollLeft: 90 });
      });
      await page.getByRole("button", { name: "Close editor", exact: true }).click();
      await expect(viewer).toBeVisible();
      await expect
        .poll(() =>
          viewer.evaluate((container) => {
            const line = container.querySelectorAll("pre code .line")[239]!;
            return Math.abs(
              line.getBoundingClientRect().top - container.getBoundingClientRect().top,
            );
          }),
        )
        .toBeLessThan(24);
      expect(await viewer.evaluate((element) => element.scrollLeft)).toBe(90);
      await capture(page, info, `after-${appearance}-returned-to-preview`);
      await page.getByRole("button", { name: "Edit file", exact: true }).click();
      await expect(input).toBeAttached();
      expect((await editorState())?.text).toBe(contents);
      await input.focus();
      await page.keyboard.press("Control+End");
      // One keystroke tests the native undo path without assuming how the
      // browser partitions a multiword EditContext insertion into undo units.
      await page.keyboard.type("x");
      await expect.poll(() => readFile(path.join(cwd, filename), "utf8")).toBe(`${contents}x`);
      await command(page, "Undo");
      await expect.poll(() => readFile(path.join(cwd, filename), "utf8")).toBe(contents);
      expect(errors).toEqual([]);
      await info.attach("presentation-verification", {
        contentType: "application/json",
        body: JSON.stringify({
          appearance,
          reducedMotion: appearance === "dark",
          previewToEditor: true,
          editorToPreview: true,
          selectionPreserved: true,
          horizontalPosition: true,
          singleEditor: true,
          realAutosaveAndUndo: true,
        }),
      });
    } finally {
      await page.goto("about:blank");
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
