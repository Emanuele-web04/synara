import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { applyHostEditFixture } from "./hostEditFixture";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcess } from "@synara/shared/processRuntime";
import { resolveExecutable } from "@synara/shared/executable";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { editorChildEnvironment } from "../editor/editorChildEnvironment";
import { activationEvents } from "./manifest";
import { OpenVsxRegistry } from "./openVsx";
import { installVsix } from "./vsix";
import { ExtensionHostConnection } from "./hostConnection";

const runtime = process.env.SYNARA_TEST_CODE_OSS_HOST;
const provider = z.object({ handle: z.number(), kind: z.string() });
const state = z.object({
  providers: z.array(provider),
  active: z.array(z.string()),
  commands: z.array(z.string()),
});
const formatEdits = z.array(
  z.object({
    text: z.string(),
    range: z.object({
      startLineNumber: z.number(),
      startColumn: z.number(),
      endLineNumber: z.number(),
      endColumn: z.number(),
    }),
  }),
);

describe.skipIf(!runtime)("real Code-OSS extension host", () => {
  it("activates the actual Open VSX Prettier VSIX and invokes its real formatter", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "synara-real-host-"));
    const workspace = path.join(temporary, "workspace");
    const storage = path.join(temporary, "storage");
    await mkdir(workspace);
    await mkdir(storage);
    const documentPath = path.join(workspace, "example.js");
    const contents = 'const value={hello:"world"}\n';
    await writeFile(documentPath, contents);
    let connection: ExtensionHostConnection | undefined;
    try {
      const registry = new OpenVsxRegistry();
      const metadata = await registry.metadata("esbenp.prettier-vscode", "12.4.0");
      const archive = await registry.download(metadata);
      const installed = await installVsix(archive, path.join(temporary, "packages"), {
        id: "esbenp.prettier-vscode",
        version: "12.4.0",
      });
      const directory = path.join(temporary, "packages", installed.directory);
      const env = editorChildEnvironment(process.env, false);
      const node = process.versions.bun
        ? resolveExecutable("node", { cwd: temporary, env })
        : process.execPath;
      if (!node)
        throw new Error(
          "Node runtime is required for the upstream extension host acceptance test.",
        );
      // This opt-in test uses an isolated, read-only-permission CI job without
      // credentials. Production launch must additionally require an OS sandbox.
      const child = spawnProcess(node, [runtime!], {
        cwd: workspace,
        env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        ownProcessGroup: true,
        requireExecutable: true,
      });
      const values = new Map<string, unknown>();
      const diagnosticEvents: unknown[] = [];
      connection = new ExtensionHostConnection(
        child,
        async (method, payload) => {
          const params = z.record(z.string(), z.unknown()).parse(payload);
          if (method === "storage.get")
            return values.get(`${String(params.shared)}:${String(params.key)}`) ?? {};
          if (method === "storage.set") {
            values.set(`${String(params.shared)}:${String(params.key)}`, params.value);
            return;
          }
          if (method === "ui.message") {
            diagnosticEvents.push(params);
            return undefined;
          }
          if (method === "workspace.exists") return false;
          if (method === "fs.stat" || method === "fs.read" || method === "fs.readdir") {
            const resource = z
              .object({ scheme: z.literal("file"), path: z.string() })
              .parse(params.resource);
            const filename = fileURLToPath(new URL(`file://${resource.path}`));
            const resolved = await realpath(filename);
            if (resolved !== temporary && !resolved.startsWith(temporary + path.sep))
              throw new Error("Test filesystem access escaped its fixture.");
            if (method === "fs.read") return (await readFile(resolved)).toString("base64");
            if (method === "fs.readdir")
              return (await readdir(resolved, { withFileTypes: true })).map((entry) => [
                entry.name,
                entry.isDirectory() ? 2 : 1,
              ]);
            const info = await stat(resolved);
            return {
              type: info.isDirectory() ? 2 : 1,
              ctime: info.ctimeMs,
              mtime: info.mtimeMs,
              size: info.size,
            };
          }
          throw new Error(`Unsupported test broker operation ${method}`);
        },
        (event, body) => {
          if (["stderr", "error", "extensionError", "activationError", "failure"].includes(event))
            diagnosticEvents.push({ event, body });
        },
      );
      try {
        const ready = await connection.request("initialize", {
          workspace,
          storage,
          extensions: [
            {
              manifest: installed.manifest,
              directory,
              activationEvents: activationEvents(installed.manifest),
            },
          ],
          documents: [
            {
              path: documentPath,
              contents,
              version: 1,
              languageId: "javascript",
              dirty: false,
              active: true,
            },
          ],
        });
        expect(ready).toMatchObject({ upstream: true, apiVersion: "1.138.0" });
        await connection.request("activate", { id: installed.id });
        const registered = state.parse(await connection.request("state", {}));
        expect(registered.active).toContain(installed.id);
        const formatter = registered.providers.find((entry) => entry.kind === "format");
        expect(formatter).toBeDefined();
        const edits = formatEdits.parse(
          await connection.request("language", {
            handle: formatter!.handle,
            path: documentPath,
            options: { tabSize: 2, insertSpaces: true },
          }),
        );
        expect(edits.length).toBeGreaterThan(0);
        expect(applyHostEditFixture(contents, edits)).toBe('const value = { hello: "world" };\n');
        expect(await readFile(documentPath, "utf8")).toBe(contents);
        await connection.request("documents", {
          documents: [
            {
              path: documentPath,
              contents: "const next={n:2}",
              version: 2,
              languageId: "javascript",
              dirty: true,
              active: true,
            },
          ],
        });
        // Active-workspace discovery replaces the global provider. Resolve
        // the live contribution again rather than reusing a disposed handle.
        const refreshed = state.parse(await connection.request("state", {}));
        const currentFormatter = refreshed.providers.find((entry) => entry.kind === "format");
        expect(currentFormatter).toBeDefined();
        const changed = formatEdits.parse(
          await connection.request("language", {
            handle: currentFormatter!.handle,
            path: documentPath,
          }),
        );
        expect(applyHostEditFixture("const next={n:2}", changed)).toBe("const next = { n: 2 };\n");
        expect(diagnosticEvents).toEqual([]);
        await connection.stop();
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        console.log(
          "REAL_CODE_OSS_PRETTIER",
          JSON.stringify({
            extension: installed.id,
            version: installed.version,
            sha256: installed.digest,
            providers: registered.providers.length,
            commandCount: registered.commands.length,
            unchangedDisk: true,
            cleanup: true,
          }),
        );
      } catch (error) {
        console.error("HOST_DIAGNOSTICS", JSON.stringify(diagnosticEvents));
        console.error("HOST_RECENT_EVENTS", JSON.stringify(connection.events));
        throw error;
      }
    } finally {
      await connection?.stop();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
