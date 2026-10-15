import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtensionRuntime } from "./extensionRuntime";
import { fixtureVsix } from "./vsixFixture";

const runtimeFile = process.env.SYNARA_TEST_CODE_OSS_HOST;
const enabled = Boolean(runtimeFile) && process.env.SYNARA_TEST_EXTENSION_SANDBOX === "1";
const providerState = z.object({
  providers: z.array(
    z.object({ kind: z.string(), handle: z.number(), metadata: z.array(z.unknown()) }),
  ),
});
const fixture = String.raw`
const vscode = require("vscode");
exports.activate = (context) => {
  const changes = [];
  const semanticChanges = new vscode.EventEmitter();
  const hintChanges = new vscode.EventEmitter();
  const selector = { scheme: "file", language: "javascript" };
  context.subscriptions.push(semanticChanges, hintChanges,
    vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      onDidChangeSemanticTokens: semanticChanges.event,
      provideDocumentSemanticTokens(document) {
        const start = document.getText().indexOf("answer");
        return new vscode.SemanticTokens(new Uint32Array(start < 0 ? [] : [0, start, 6, 0, 1]));
      },
    }, new vscode.SemanticTokensLegend(["variable"], ["declaration"])),
    vscode.languages.registerInlayHintsProvider(selector, {
      onDidChangeInlayHints: hintChanges.event,
      provideInlayHints(document) {
        const start = document.getText().indexOf("answer");
        if (start < 0) return [];
        const hint = new vscode.InlayHint(new vscode.Position(0, start + 6), ": number", vscode.InlayHintKind.Type);
        hint.paddingRight = true;
        return [hint];
      },
    }),
    vscode.commands.registerCommand("synara.fixture.refresh", () => { semanticChanges.fire(); hintChanges.fire(); return true; }),
    vscode.commands.registerCommand("synara.fixture.events", () => changes.slice()),
  );
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.watch");
  context.subscriptions.push(watcher,
    watcher.onDidCreate((uri) => changes.push({ type: "create", path: uri.fsPath })),
    watcher.onDidChange((uri) => changes.push({ type: "change", path: uri.fsPath })),
    watcher.onDidDelete((uri) => changes.push({ type: "delete", path: uri.fsPath })),
  );
};
`;

describe.skipIf(!enabled)("real Code-OSS semantic, hint and filesystem adapters", () => {
  it("uses upstream providers and external file events without replacing dirty native documents", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "synara-native-language-"));
    const cwd = path.join(temporary, "workspace"),
      stateDir = path.join(temporary, "state"),
      outside = path.join(temporary, "outside");
    for (const folder of [cwd, stateDir, outside]) await mkdir(folder);
    const relativePath = "fixture.js",
      contents = "const answer = 42;\n";
    await writeFile(path.join(cwd, relativePath), contents);
    const manifest = {
      publisher: "synara-fixture",
      name: "native-language",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      main: "index.js",
      activationEvents: ["onLanguage:javascript"],
    };
    const archive = fixtureVsix([
      { name: "extension/package.json", contents: JSON.stringify(manifest) },
      { name: "extension/index.js", contents: fixture },
    ]);
    const runtime = new ExtensionRuntime(stateDir, runtimeFile);
    const owner = "language-fixture-owner";
    try {
      const upload = await runtime.request(owner, {
        operation: "uploadBegin",
        total: archive.length,
      });
      const uploadId = upload.uploadId!;
      await runtime.request(owner, {
        operation: "uploadAppend",
        uploadId,
        offset: 0,
        chunk: archive.toString("base64"),
      });
      const installed = await runtime.request(owner, { operation: "uploadFinish", uploadId });
      const extension = installed.extensions[0]!;
      await runtime.request(owner, { operation: "setTrust", cwd, trusted: true });
      await runtime.request(owner, {
        operation: "setEnabled",
        id: extension.id,
        enabled: true,
        consent: [{ id: extension.id, digest: extension.digest }],
      });
      const started = await runtime.runtimeRequest(owner, {
        operation: "start",
        cwd,
        documents: [{ relativePath, contents, version: 1 }],
      });
      const hostId = started.hostId;
      await expect
        .poll(
          async () => {
            const result = await runtime.runtimeRequest(owner, { operation: "poll", cwd, hostId });
            if (result.status === "failed") throw new Error(JSON.stringify(result.events));
            return result.status;
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe("running");
      const invoke = async (method: "activate" | "state" | "language" | "command", params = {}) => {
        const result = await runtime.runtimeRequest(owner, {
          operation: "request",
          cwd,
          hostId,
          method,
          paramsJson: JSON.stringify(params),
        });
        return result.resultJson === undefined ? undefined : JSON.parse(result.resultJson);
      };
      await invoke("activate", { id: extension.id });
      const state = providerState.parse(await invoke("state"));
      const tokens = state.providers.find((provider) => provider.kind === "semanticTokens")!;
      const hints = state.providers.find((provider) => provider.kind === "inlayHints")!;
      expect(tokens).toBeDefined();
      expect(hints).toBeDefined();
      expect(tokens.metadata[0]).toEqual({
        tokenTypes: ["variable"],
        tokenModifiers: ["declaration"],
      });
      const tokenParams = { handle: tokens.handle, relativePath };
      expect(await invoke("language", tokenParams)).toEqual({ data: [0, 6, 6, 0, 1] });
      // Repeated full requests exercise release/recreation rather than retaining
      // a result-id cache coupled to a different document or renderer.
      expect(await invoke("language", tokenParams)).toEqual({ data: [0, 6, 6, 0, 1] });
      const hintParams = {
        handle: hints.handle,
        relativePath,
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
      };
      expect(await invoke("language", hintParams)).toMatchObject([
        { label: ": number", position: { lineNumber: 1, column: 13 }, paddingRight: true },
      ]);
      const dirty = "let answer = 7;\n";
      await runtime.runtimeRequest(owner, {
        operation: "sync",
        cwd,
        hostId,
        documents: [{ relativePath, contents: dirty, version: 2 }],
      });
      expect(await invoke("language", tokenParams)).toEqual({ data: [0, 4, 6, 0, 1] });
      expect(await invoke("language", hintParams)).toMatchObject([
        { position: { lineNumber: 1, column: 11 } },
      ]);
      const previous = await runtime.runtimeRequest(owner, { operation: "poll", cwd, hostId });
      await invoke("command", { id: "synara.fixture.refresh" });
      await expect
        .poll(
          async () =>
            (
              await runtime.runtimeRequest(owner, {
                operation: "poll",
                cwd,
                hostId,
                after: previous.sequence,
              })
            ).events.filter((event) => event.event === "providers").length,
        )
        .toBeGreaterThanOrEqual(2);
      const changes = async () =>
        z
          .array(z.object({ type: z.string(), path: z.string() }))
          .parse(await invoke("command", { id: "synara.fixture.events" }));
      const watched = path.join(cwd, "external.watch");
      await writeFile(watched, "created");
      await expect
        .poll(
          async () =>
            (await changes()).some((event) => event.type === "create" && event.path === watched),
          { timeout: 5_000 },
        )
        .toBe(true);
      await writeFile(watched, "modified externally");
      await expect
        .poll(
          async () =>
            (await changes()).some((event) => event.type === "change" && event.path === watched),
          { timeout: 5_000 },
        )
        .toBe(true);
      await rm(watched);
      await expect
        .poll(
          async () =>
            (await changes()).some((event) => event.type === "delete" && event.path === watched),
          { timeout: 5_000 },
        )
        .toBe(true);
      await symlink(outside, path.join(cwd, "escaped"), "dir");
      await writeFile(path.join(outside, "secret.watch"), "not a workspace event");
      const sentinel = path.join(cwd, "sentinel.watch");
      await writeFile(sentinel, "barrier");
      await expect
        .poll(async () => (await changes()).some((event) => event.path === sentinel), {
          timeout: 5_000,
        })
        .toBe(true);
      expect((await changes()).some((event) => event.path.includes("secret.watch"))).toBe(false);
      expect(await invoke("language", tokenParams)).toEqual({ data: [0, 4, 6, 0, 1] });
      expect(await readFile(path.join(cwd, relativePath), "utf8")).toBe(contents);
      await runtime.runtimeRequest(owner, { operation: "stop", cwd, hostId });
      console.log(
        "REAL_CODE_OSS_LANGUAGE_FIXTURE",
        JSON.stringify({
          upstream: true,
          fixtureVsix: extension.digest,
          fullSemanticTokens: true,
          inlayHints: true,
          invalidation: true,
          externalFileEvents: true,
          symlinkExcluded: true,
          dirtySnapshotPreserved: true,
          cleanup: true,
        }),
      );
    } finally {
      await runtime.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 90_000);
});
