import type { Page, TestInfo } from "playwright/test";

export async function capture(page: Page, info: TestInfo, name: string) {
  const filename = info.outputPath(`${name}.png`);
  await page.screenshot({ path: filename, fullPage: true });
  await info.attach(name, { path: filename, contentType: "image/png" });
}
async function focusEditor(page: Page) {
  await page.evaluate(async () => {
    const modulePath = "/src/components/codeEditor/editorRuntime.ts";
    const { monaco } = await import(/* @vite-ignore */ modulePath);
    const editor = monaco.editor
      .getEditors()
      .find(
        (candidate: { getModel(): { uri: { scheme: string } } | null }) =>
          candidate.getModel()?.uri.scheme === "synara-workspace",
      );
    if (!editor) throw new Error("Native Synara editor is not mounted.");
    editor.focus();
  });
}
export async function command(page: Page, name: string) {
  await focusEditor(page);
  await page.keyboard.press("F1");
  await page.getByRole("combobox", { name: "Editor commands" }).fill(name);
  await page.getByRole("option", { name, exact: false }).click();
}
export async function bridgePhase(page: Page) {
  return page.evaluate(async () => {
    const runtimePath = "/src/components/codeEditor/editorRuntime.ts";
    const modelsPath = "/src/components/codeEditor/editorModels.ts";
    const bridgePath = "/src/components/codeEditor/editorExtensionBridge.ts";
    const [{ monaco }, { editorEntry }, { getEditorExtensionBridge }] = await Promise.all([
      import(/* @vite-ignore */ runtimePath),
      import(/* @vite-ignore */ modelsPath),
      import(/* @vite-ignore */ bridgePath),
    ]);
    const model = monaco.editor
      .getModels()
      .find(
        (candidate: { uri: { scheme: string } }) => candidate.uri.scheme === "synara-workspace",
      );
    const entry = model && editorEntry(model);
    if (!entry?.cwd) throw new Error("Native workspace model is unavailable.");
    const state = getEditorExtensionBridge(entry.client, entry.cwd).getSnapshot();
    if (state.phase === "failed") throw new Error(state.error ?? "Extension host failed.");
    return state.phase;
  });
}
