// Temporary bounded repair; removed from the normalized application candidate.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const content = await readFile(file, "utf8");
  if (content.split(before).length !== 2) throw new Error(`Expected one anchor in ${file}: ${before}`);
  await writeFile(file, content.replace(before, after));
}
const registry = "apps/server/src/extensions/openVsx.ts";
await edit(registry, '    if (response.offset !== offset)', `    // RegistryAPI.search leaves resultOffset at zero for its first registry.
    // Keep our bounded request cursor authoritative instead of resetting it.
    // See eclipse-openvsx/openvsx RegistryAPI.java at 72b6c54, search().
    if (response.offset !== 0 && response.offset !== offset)`);
await edit(registry, 'extensions: z.array(summarySchema).max(100),', 'extensions: z.array(summarySchema).max(24),');
const testFile = 'apps/server/src/extensions/registryCatalog.test.ts';
await writeFile(testFile, await readFile(testFile, 'utf8') + `

it("advances a requested page when the upstream registry reports its default zero offset", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ offset: 0, totalSize: 90,
    extensions: Array.from({ length: 24 }, (_, index) => ({ ...summary, name: 'page-two-' + index })) }));
  const result = await new OpenVsxRegistry(request).catalog({ offset: 24 });
  expect(new URL(String(request.mock.calls[0]![0])).searchParams.get("offset")).toBe("24");
  expect(result.registryResults[0]?.name).toBe("page-two-0");
  expect(result.registryNextOffset).toBe(48);
});
`);
const ui = 'apps/web/src/components/settings/ExtensionMarketplace.tsx';
await edit(ui, '  DialogFooter,', '  DialogFooter,\n  DialogHeader,\n  DialogPanel,');
await edit(ui, '<DialogPopup className="max-w-xl">', '<DialogPopup className="max-w-xl" showCloseButton={false}>');
await edit(ui, '<div className="space-y-5 p-5">\n              <div className="flex items-start gap-3">', '<>\n              <DialogHeader>\n              <div className="flex items-start gap-3">');
await edit(ui, '              <p className="whitespace-pre-wrap break-words text-ui text-muted-foreground">', '              </DialogHeader>\n              <DialogPanel className="space-y-4">\n              <p className="whitespace-pre-wrap break-words text-ui text-muted-foreground">');
await edit(ui, '              <DialogFooter>', '              </DialogPanel>\n              <DialogFooter>');
await edit(ui, '              </DialogFooter>\n            </div>', '              </DialogFooter>\n            </>');
// Retain page recovery controls even when the subsequent read fails.
await edit(ui, '(offset > 0 || nextOffset !== undefined) && catalog.data ? (', 'offset > 0 || nextOffset !== undefined ? (');
// Details errors occur in a portal: the catalog's parent alert is not accessible
// while its modal is open, so show the same mutation failure next to its action.
await edit(ui, '  active: boolean;\n', '  active: boolean;\n  operationError: string | null;\n');
await edit(ui, '              <DialogFooter>', `              {props.operationError ? <p role="alert" className="px-4 text-ui text-destructive">{props.operationError}</p> : null}
              <DialogFooter>`);
const panel = 'apps/web/src/components/settings/EditorExtensionsSettingsPanel.tsx';
await edit(panel, '          entries={entries}', '          entries={entries}\n          operationError={error}');
const e2e = 'apps/web/e2e/editorMarketplace.e2e.ts';
await edit(e2e, '    await capture(page, info, "marketplace-after-discover");', '    const firstPage = await cards.getByRole("button", { name: /^Details for/ }).allTextContents();\n    await capture(page, info, "marketplace-after-discover");');
await edit(e2e, '    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();', `    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const secondPage = await cards.getByRole("button", { name: /^Details for/ }).allTextContents();
      return secondPage.length > 0 && JSON.stringify(secondPage) !== JSON.stringify(firstPage);
    }, { timeout: 40_000 }).toBe(true);`);
await edit(e2e, '  } finally {', `  } catch (error) {
    console.error("MARKETPLACE_VISIBLE_FAILURE", await page.locator("main").innerText().catch(() => "Page closed"));
    throw error;
  } finally {`);
console.log('Repaired upstream paging, unambiguous modal close, scrollable details and modal mutation feedback.');
