// Temporary integration helper, omitted from the final application tree.
import { readFile, writeFile } from "node:fs/promises";
const file = "apps/server/src/extensions/host/entry.mjs";
let contents = await readFile(file, "utf8");
function edit(before, after) {
  if (contents.split(before).length !== 2) throw new Error(`Expected one file-event integration anchor: ${before}`);
  contents = contents.replace(before, after);
}
contents = 'import { NativeFileEvents } from "./fileEventAdapter.mjs";\n' + contents;
edit('let initialization;', 'let initialization;\nlet fileEvents;');
edit('      $watch(extensionId, session, resource, options) {\n        event("watch.add", { extensionId, session, resource, options });\n      },', '      async $watch(extensionId, session, resource, options) {\n        await fileEvents.watch(session, resource, options);\n        event("watch.add", { extensionId, session, resource, options });\n      },');
edit('      $unwatch(session) {\n        event("watch.remove", { session });\n      },', '      $unwatch(session) {\n        fileEvents?.unwatch(session);\n        event("watch.remove", { session });\n      },');
edit('  initialization = params;', '  initialization = params;\n  fileEvents = new NativeFileEvents(params.workspace, (events) => actor("ExtHostFileSystemEventService").$onFileEvent(events),\n    (message) => event("error", message), params.configuration?.["files.watcherExclude"] ?? {});');
edit('  await host._extensionService.getExtensionRegistry();', '  await host._extensionService.getExtensionRegistry();\n  await fileEvents.start().catch((error) => event("error", "Extension file watching is unavailable: " + error.message));');
edit('    case "shutdown":', '    case "shutdown":\n      fileEvents?.dispose();');
contents += '\nprocess.once("exit", () => fileEvents?.dispose());\n';
await writeFile(file, contents);
const watcherFile = "apps/server/src/extensions/host/fileEventAdapter.mjs";
let watcher = await readFile(watcherFile, "utf8");
function fix(before, after) {
  if (watcher.split(before).length !== 2) throw new Error(`Expected one watcher anchor: ${before}`);
  watcher = watcher.replace(before, after);
}
fix('    // Explicit subscriptions are correlated,', '    this.unwatch(session);\n    await this.start();\n    const global = this.groups.get("workspace");\n    if (global && !this.excluded(global, filename) && !options.includes?.length) return;\n    // Explicit subscriptions are correlated,');
fix('timer: undefined, running: false, ready: false', 'timer: undefined, running: true, ready: false');
fix('      group.ready = true;', '      group.ready = true;\n      group.running = false;\n      if (group.dirty.size) this.schedule(group, group.dirty.values().next().value);');
fix('directory: info.isDirectory(), stamp:', 'directory: info.isDirectory(), identity: `${info.dev}:${info.ino}`, stamp:');
fix('if (!current || current.directory !== previous.directory) {', 'if (!current || current.directory !== previous.directory || (current.directory && current.identity !== previous.identity)) {');
fix('if (!previous || previous.directory !== current.directory) created.push(filename);', 'if (!previous || previous.directory !== current.directory || (current.directory && current.identity !== previous.identity)) created.push(filename);');
await writeFile(watcherFile, watcher);
console.log("Connected bounded external file events, startup serialization, watch de-duplication and directory replacement handling.");
