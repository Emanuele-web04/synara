// Temporary integration repair and existing journey migration, excluded from publication.
import { readFile, writeFile } from "node:fs/promises";
await import('./assemble-extension-marketplace.mjs');
async function edit(file, before, after) {
  const content = await readFile(file, "utf8");
  if (content.split(before).length !== 2) throw new Error(`Expected one anchor in ${file}: ${before}`);
  await writeFile(file, content.replace(before, after));
}
const panel = 'apps/web/src/components/settings/EditorExtensionsSettingsPanel.tsx';
await edit(panel, '    onSuccess: (result, input) => {', '    onError: () => { void queryClient.invalidateQueries({ queryKey: stateKey }); },\n    onSuccess: (result, input) => {');
// Keep all original lifecycle assertions; only update the requested UI entry points.
const formatter = 'apps/web/e2e/editorExtensions.e2e.ts';
await edit(formatter, '    await expect(page.getByText("No editor extensions installed.", { exact: true })).toBeVisible();', '    await page.getByRole("radio", { name: /^Installed/ }).click();\n    await expect(page.getByText("No editor extensions installed.", { exact: true })).toBeVisible();\n    await page.getByRole("radio", { name: "Marketplace", exact: true }).click();');
await edit(formatter, '.locator(\'[data-slot="settings-row"]\')', '.getByTestId("extension-card")');
let text = await readFile(formatter, 'utf8');
text = text.replaceAll('name: "Install compatible version"', 'name: "Install", exact: true');
text = text.replace('    const installed = page', '    await page.getByRole("radio", { name: /^Installed/ }).click();\n    const installed = page');
text = text.replace('    await page.getByRole("textbox", { name: "Workspace directory" }).fill(cwd);', '    await page.getByRole("radio", { name: "Permissions", exact: true }).click();\n    await page.getByRole("textbox", { name: "Workspace directory" }).fill(cwd);');
await writeFile(formatter, text);
const debuggerTest = 'apps/web/e2e/editorExtensionDebug.e2e.ts';
await edit(debuggerTest, 'const result = page.locator(\'[data-slot="settings-row"]\')', 'const result = page.getByTestId("extension-card")');
await edit(debuggerTest, '    await result.getByRole("button", { name: "Install compatible version" }).click();', '    await result.getByRole("button", { name: "Install", exact: true }).click();\n    await page.getByRole("radio", { name: /^Installed/ }).click();');
await edit(debuggerTest, '    await page.getByRole("textbox", { name: "Workspace directory" }).fill(cwd);', '    await page.getByRole("radio", { name: "Permissions", exact: true }).click();\n    await page.getByRole("textbox", { name: "Workspace directory" }).fill(cwd);');
const vsix = 'apps/web/e2e/editorExtensionVsix.e2e.ts';
await edit(vsix, '    await page.goto("/settings?section=extensions");', '    await page.goto("/settings?section=extensions");\n    await page.getByRole("radio", { name: /^Installed/ }).click();');
console.log('Preserved explicit approvals, trusted workspace checks and existing formatter/debugger/VSIX assertions.');
