// Temporary exact-anchor edits, omitted from the published application tree.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one final integration anchor in ${file}: ${before}`);
  await writeFile(file, source.replace(before, after));
}
await edit("apps/web/playwright.extensions.config.ts", 'testMatch: ["editorExtensions.e2e.ts", "editorExtensionDebug.e2e.ts"],', 'testMatch: ["editorExtensions.e2e.ts", "editorExtensionDebug.e2e.ts", "editorExtensionVsix.e2e.ts"],');
// Upstream $watch is fire-and-forget. Report an unavailable native watch without
// producing an unhandled rejection that could destabilize unrelated extensions.
await edit("apps/server/src/extensions/host/entry.mjs", '        await fileEvents.watch(session, resource, options);\n        event("watch.add", { extensionId, session, resource, options });', '        try {\n          await fileEvents.watch(session, resource, options);\n          event("watch.add", { extensionId, session, resource, options });\n        } catch (error) {\n          event("error", "Extension watcher is unavailable: " + error.message);\n        }');
const test = "apps/server/src/extensions/realLanguageFeatures.test.ts";
await edit(test, '    vscode.commands.registerCommand("synara.fixture.events", () => changes.slice()),', '    vscode.commands.registerCommand("synara.fixture.events", () => changes.slice()),\n    vscode.commands.registerCommand("synara.fixture.blockedWatch", () => {\n      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(process.env.HOME, "**/*.watch"));\n      context.subscriptions.push(watcher);\n      return true;\n    }),');
await edit(test, '      const changes = async () =>', '      const watchStart = await runtime.runtimeRequest(owner, { operation: "poll", cwd, hostId });\n      await invoke("command", { id: "synara.fixture.blockedWatch" });\n      await expect.poll(async () => {\n        const result = await runtime.runtimeRequest(owner, { operation: "poll", cwd, hostId, after: watchStart.sequence });\n        expect(result.status).toBe("running");\n        return result.events.some((event) => event.event === "error" && event.bodyJson.includes("watcher leaves its workspace"));\n      }, { timeout: 5_000 }).toBe(true);\n      const changes = async () =>');
const docs = "docs/editor/extensions.md";
const text = await readFile(docs, "utf8");
await writeFile(docs, text.replace('The local file-picker/upload journey is not yet a separate end-to-end scenario.', 'The local file-picker/upload journey now has a dedicated real-application scenario for rejection, approval, configuration, replacement and removal; consult its CI outcome.'));
console.log("Added actual VSIX file-picker acceptance and contained fire-and-forget watcher failures.");
