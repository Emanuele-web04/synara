import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "@synara/shared/executable";
import { z } from "zod";
import type {
  EditorDocument,
  EditorExtensionRuntimeEvent,
  EditorExtensionRuntimeInput,
  EditorExtensionRuntimeResult,
  EditorExtensionsInput,
  EditorExtensionsResult,
} from "@synara/contracts";
import { pathWithin, spawnSandboxedExtensionHost } from "../platform/extensionHostSandbox";
import { ExtensionManager } from "./extensionManager";
import { ExtensionHostConnection } from "./hostConnection";
import { activationEvents, CODE_OSS_COMMIT, CODE_OSS_VERSION, extensionId } from "./manifest";

class CodeOssRuntimeNotBuiltError extends Error {}

const runtimeManifest = z.object({
  commit: z.literal(CODE_OSS_COMMIT),
  version: z.literal(CODE_OSS_VERSION),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  entry: z.literal("extension-host.mjs"),
});
const record = z.record(z.string(), z.unknown());
const resourceSchema = z.object({
  scheme: z.literal("file"),
  path: z.string().max(4_096),
  authority: z.string().optional(),
});
const defaultLanguages: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".py": "python",
  ".md": "markdown",
  ".css": "css",
  ".html": "html",
  ".rs": "rust",
  ".go": "go",
};
interface Snapshot {
  path: string;
  contents: string;
  version: number;
  languageId: string;
  dirty: boolean;
  active: boolean;
}
interface NativePending {
  id: number;
  method: string;
  params: unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface RuntimeSlot {
  id: string;
  owner: string;
  cwd: string;
  storage: string;
  state: EditorExtensionRuntimeResult["status"];
  touched: number;
  abort: AbortController;
  flight: Promise<void>;
  connection?: ExtensionHostConnection;
  events: EditorExtensionRuntimeEvent[];
  eventBytes: number;
  sequence: number;
  nativeSequence: number;
  pending: Map<number, NativePending>;
  snapshots: Map<string, Snapshot>;
  extensionDirectories: string[];
  windowStarted: number;
  windowEvents: number;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const required = (value: string | undefined, label: string) => {
  if (!value) throw new Error(`${label} is required.`);
  return value;
};

/** Synara owns authorization, lifecycle, files and visible interactions. */
export class ExtensionRuntime {
  readonly manager: ExtensionManager;
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly sweep: ReturnType<typeof setInterval>;
  private disposed = false;
  private generation = 0;
  private readonly starts = new Map<string, Promise<RuntimeSlot>>();
  private runtimeFile: string | undefined;
  private storageWrites: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly stateDir: string,
    private readonly runtimeOverride = process.env.SYNARA_CODE_OSS_RUNTIME,
  ) {
    this.manager = new ExtensionManager(stateDir, undefined, {
      state: () => this.currentState(),
      stopAll: () => this.stopAll(),
    });
    this.sweep = setInterval(() => {
      for (const slot of this.slots.values())
        if (Date.now() - slot.touched > 180_000) {
          void this.stop(slot).catch((error: unknown) =>
            this.emit(slot, "cleanupError", message(error)),
          );
        }
    }, 30_000).unref();
  }
  private currentState(): EditorExtensionsResult["runtime"] {
    if (process.platform !== "linux") return "unsupported";
    for (const slot of this.slots.values())
      if (slot.state === "running" || slot.state === "starting") return slot.state;
    if ([...this.slots.values()].some((slot) => slot.state === "failed")) return "failed";
    return this.runtimeFile ? "stopped" : "not-built";
  }
  async request(
    owner: string,
    input: EditorExtensionsInput,
    signal?: AbortSignal,
  ): Promise<EditorExtensionsResult> {
    if (this.disposed) throw new Error("Extensions are shutting down.");
    if (input.operation === "list" && !this.runtimeFile && process.platform === "linux") {
      // Detect a verified installed runtime without launching extension code.
      try {
        await this.findRuntime();
      } catch (error) {
        if (!(error instanceof CodeOssRuntimeNotBuiltError)) throw error;
      }
    }
    return this.manager.request(owner, input, signal);
  }
  private async findRuntime(): Promise<string> {
    const candidates = this.runtimeOverride
      ? [this.runtimeOverride]
      : [
          fileURLToPath(new URL("./code-oss/extension-host.mjs", import.meta.url)),
          fileURLToPath(new URL("../../dist/code-oss/extension-host.mjs", import.meta.url)),
        ];
    for (const candidate of candidates) {
      const info = await lstat(candidate).catch(() => undefined);
      if (!info) continue;
      if (!info.isFile() || info.size > 64 * 1_024 * 1_024)
        throw new Error("Invalid Code-OSS runtime entry.");
      const filename = await realpath(candidate);
      const manifestFile = path.join(path.dirname(filename), "runtime.json");
      if ((await stat(manifestFile)).size > 16_384)
        throw new Error("Invalid Code-OSS runtime manifest.");
      const metadata = runtimeManifest.parse(JSON.parse(await readFile(manifestFile, "utf8")));
      const digest = createHash("sha256")
        .update(await readFile(filename))
        .digest("hex");
      if (digest !== metadata.sha256)
        throw new Error("Code-OSS runtime integrity check failed. Rebuild the pinned runtime.");
      this.runtimeFile = filename;
      return filename;
    }
    throw new CodeOssRuntimeNotBuiltError(
      "The optional Code-OSS runtime is not built. Build the pinned extension runtime before enabling execution.",
    );
  }
  private emit(slot: RuntimeSlot, event: string, body: unknown): void {
    const now = Date.now();
    if (now - slot.windowStarted >= 1_000) {
      slot.windowStarted = now;
      slot.windowEvents = 0;
    }
    if (++slot.windowEvents > 1_000 && slot.state !== "stopping" && slot.state !== "failed") {
      slot.state = "failed";
      void this.stop(slot).catch(() => undefined);
      return;
    }
    const bodyJson = JSON.stringify(body ?? null);
    if (bodyJson.length > 1_000_000) {
      this.emit(slot, "error", "Extension contribution exceeds its payload limit.");
      return;
    }
    const entry = { sequence: ++slot.sequence, event, bodyJson };
    slot.events.push(entry);
    slot.eventBytes += bodyJson.length;
    while (slot.events.length > 128 || slot.eventBytes > 2_000_000)
      slot.eventBytes -= slot.events.shift()!.bodyJson.length;
  }
  private snapshot(slot: RuntimeSlot, after = 0, result?: unknown): EditorExtensionRuntimeResult {
    const resultJson = result === undefined ? undefined : JSON.stringify(result);
    if (resultJson && resultJson.length > 4_000_000)
      throw new Error("Extension response exceeds its size limit.");
    return {
      hostId: slot.id,
      status: slot.state,
      sequence: slot.sequence,
      events: slot.events.filter((entry) => entry.sequence > after),
      ...(resultJson === undefined ? {} : { resultJson }),
    };
  }
  private own(owner: string, input: EditorExtensionRuntimeInput): RuntimeSlot {
    const slot = this.slots.get(required(input.hostId, "Extension host identifier"));
    if (!slot || slot.owner !== owner)
      throw new Error("This extension host is not owned by the current connection.");
    slot.touched = Date.now();
    return slot;
  }
  private start(
    owner: string,
    cwd: string,
    documents: readonly EditorDocument[],
  ): Promise<RuntimeSlot> {
    const key = JSON.stringify([owner, cwd]);
    const existing = this.starts.get(key);
    if (existing) return existing;
    const pending = this.startOnce(owner, cwd, documents).finally(() => this.starts.delete(key));
    this.starts.set(key, pending);
    return pending;
  }
  private async startOnce(
    owner: string,
    cwdInput: string,
    documents: readonly EditorDocument[],
  ): Promise<RuntimeSlot> {
    const generation = this.generation;
    if (this.disposed) throw new Error("Extensions are shutting down.");
    const cwd = await realpath(cwdInput);
    const existing = [...this.slots.values()].find(
      (slot) =>
        slot.owner === owner && slot.cwd === cwd && ["starting", "running"].includes(slot.state),
    );
    if (existing) return existing;
    if (this.slots.size >= 4)
      throw new Error("Stop an existing extension host before starting another workspace.");
    const executable = await this.manager.executableExtensions(cwd);
    if (generation !== this.generation || this.disposed)
      throw new Error("Extension permissions changed during startup.");
    if (executable.length === 0) throw new Error("No approved, enabled extensions are installed.");
    const id = randomUUID();
    const storage = path.join(
      this.manager.home,
      "storage",
      createHash("sha256").update(cwd).digest("hex"),
    );
    const slot: RuntimeSlot = {
      id,
      owner,
      cwd,
      storage,
      state: "starting",
      touched: Date.now(),
      abort: new AbortController(),
      flight: Promise.resolve(),
      events: [],
      eventBytes: 0,
      sequence: 0,
      nativeSequence: 1,
      pending: new Map(),
      snapshots: new Map(),
      extensionDirectories: executable.map((entry) => entry.directory),
      windowStarted: Date.now(),
      windowEvents: 0,
    };
    this.slots.set(id, slot);
    slot.flight = (async () => {
      try {
        const runtime = await this.findRuntime();
        await mkdir(storage, { recursive: true, mode: 0o700 });
        for (const directory of ["home", "global", "workspaces", "logs", "values"])
          await mkdir(path.join(storage, directory), { recursive: true, mode: 0o700 });
        const node =
          !process.versions.bun &&
          !process.versions.electron &&
          Number(process.versions.node.split(".")[0]) >= 24
            ? process.execPath
            : resolveExecutable("node", { cwd, env: process.env });
        if (!node)
          throw new Error("A Node.js 24 runtime is required by the Code-OSS extension host.");
        slot.abort.signal.throwIfAborted();
        const child = await spawnSandboxedExtensionHost({
          workspace: cwd,
          storage,
          packages: this.manager.packages,
          runtime,
          stateDir: this.stateDir,
          node,
        });
        const connection = new ExtensionHostConnection(
          child,
          (method, params, signal) => this.nativeRequest(slot, method, params, signal),
          (event, body) => {
            if (event === "exit" || event === "failure")
              slot.state = slot.state === "stopping" ? "stopped" : "failed";
            this.emit(slot, event, body);
          },
        );
        slot.connection = connection;
        slot.abort.signal.throwIfAborted();
        const snapshots = await this.snapshots(slot, documents);
        await connection.request(
          "initialize",
          {
            workspace: cwd,
            workspaceId: createHash("sha256").update(cwd).digest("hex"),
            storage,
            configuration: Object.assign(
              {},
              ...executable.map((entry) => entry.entry.configuration),
            ),
            extensions: executable.map((entry) => ({
              manifest: entry.manifest,
              directory: entry.directory,
              activationEvents: activationEvents(entry.manifest),
            })),
            documents: snapshots,
          },
          slot.abort.signal,
        );
        slot.abort.signal.throwIfAborted();
        slot.state = "running";
        this.emit(slot, "ready", {
          apiVersion: CODE_OSS_VERSION,
          elapsedMs: performance.now() - connection.startedAt,
        });
        await connection.request("activate", { event: "onStartupFinished" }, slot.abort.signal);
        for (const languageId of new Set(snapshots.map((document) => document.languageId)))
          await connection.request(
            "activate",
            { event: `onLanguage:${languageId}` },
            slot.abort.signal,
          );
      } catch (error) {
        slot.state = "failed";
        this.emit(slot, "error", message(error));
        if (slot.connection)
          await slot.connection
            .stop()
            .catch((cleanup: unknown) => this.emit(slot, "cleanupError", message(cleanup)));
      }
    })();
    return slot;
  }
  private async workspacePath(
    slot: RuntimeSlot,
    relativePath: string,
    allowMissing = false,
  ): Promise<string> {
    if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath))
      throw new Error("Expected a relative workspace path.");
    const filename = path.resolve(slot.cwd, relativePath);
    if (!pathWithin(slot.cwd, filename) || filename === slot.cwd)
      throw new Error("Extension path escapes its workspace.");
    const resolved = await realpath(filename).catch(async (error: unknown) => {
      if (
        !allowMissing ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      return path.join(await realpath(path.dirname(filename)), path.basename(filename));
    });
    if (!pathWithin(slot.cwd, resolved))
      throw new Error("Extension path escapes its workspace through a symlink.");
    return resolved;
  }
  private async snapshots(
    slot: RuntimeSlot,
    input: readonly EditorDocument[],
  ): Promise<Snapshot[]> {
    if (input.reduce((total, document) => total + document.contents.length, 0) > 4_000_000)
      throw new Error("Native extension document snapshots exceed the size limit.");
    const result: Snapshot[] = [];
    for (const document of input) {
      const filename = await this.workspacePath(slot, document.relativePath, true);
      const previous = slot.snapshots.get(filename);
      const version = document.version + 1;
      if (
        previous &&
        (version < previous.version ||
          (version === previous.version && document.contents !== previous.contents))
      ) {
        throw new Error(
          "The extension host received a stale or conflicting native document version.",
        );
      }
      const snapshot: Snapshot = {
        path: filename,
        contents: document.contents,
        version,
        languageId: defaultLanguages[path.extname(filename).toLowerCase()] ?? "plaintext",
        dirty: true,
        active: result.length === 0,
      };
      slot.snapshots.set(filename, snapshot);
      result.push(snapshot);
    }
    return result;
  }
  private async resourcePath(slot: RuntimeSlot, value: unknown, write = false): Promise<string> {
    const resource = resourceSchema.parse(value);
    if (resource.authority || !path.isAbsolute(resource.path) || resource.path.includes("\0"))
      throw new Error("Invalid extension filesystem resource.");
    const candidate = path.normalize(resource.path);
    const resolved = await realpath(candidate).catch(async (error: unknown) => {
      if (
        !write ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      return path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
    });
    const roots = write
      ? [slot.cwd, slot.storage]
      : [slot.cwd, slot.storage, ...slot.extensionDirectories];
    if (!roots.some((root) => pathWithin(root, resolved)))
      throw new Error("Extension filesystem access exceeds its granted scope.");
    return resolved;
  }
  private uiRequest(
    slot: RuntimeSlot,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (slot.pending.size >= 32)
      return Promise.reject(new Error("Too many pending native extension interactions."));
    const id = slot.nativeSequence++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(new Error("Extension interaction was cancelled."));
      };
      const cleanup = () => {
        const item = slot.pending.get(id);
        if (item) clearTimeout(item.timer);
        slot.pending.delete(id);
        signal.removeEventListener("abort", abort);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The native Synara client did not answer the extension interaction."));
      }, 110_000).unref();
      slot.pending.set(id, {
        id,
        method,
        params,
        timer,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.emit(slot, "nativeRequest", { id, method, params });
    });
  }
  private async nativeRequest(
    slot: RuntimeSlot,
    method: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const params = record.parse(payload);
    if (method === "storage.get" || method === "storage.set") {
      const key = extensionId(z.string().parse(params.key));
      const hash = createHash("sha256")
        .update(`${Boolean(params.shared)}:${key}`)
        .digest("hex");
      // Mementos are broker-owned, outside child-writable mounts. Global state
      // is shared across workspaces; workspace state remains explicitly scoped.
      const scope =
        params.shared === true ? "global" : createHash("sha256").update(slot.cwd).digest("hex");
      const values = path.join(this.manager.home, "mementos", scope);
      await mkdir(values, { recursive: true, mode: 0o700 });
      const file = path.join(values, `${hash}.json`);
      if (method === "storage.get") {
        await this.storageWrites;
        const info = await lstat(file).catch(() => undefined);
        if (info && (!info.isFile() || info.size > 1_000_000))
          throw new Error("Invalid extension memento file.");
        const contents = await readFile(file, "utf8").catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return "{}";
          throw error;
        });
        if (contents.length > 1_000_000)
          throw new Error("Extension storage exceeds its size limit.");
        return JSON.parse(contents);
      }
      const contents = JSON.stringify(params.value ?? {});
      if (contents.length > 1_000_000) throw new Error("Extension storage exceeds its size limit.");
      const next = this.storageWrites.then(async () => {
        const temporary = path.join(values, `.value-${randomUUID()}.json`);
        try {
          await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
      this.storageWrites = next.catch(() => undefined);
      await next;
      return;
    }
    if (["fs.stat", "fs.read", "fs.readdir"].includes(method)) {
      throw new Error("Extension file reads must execute inside the OS sandbox.");
    }
    if (method === "fs.write") {
      const filename = await this.resourcePath(slot, params.resource, true);
      const contents = z.string().max(5_400_000).parse(params.contents);
      const bytes = Buffer.from(contents, "base64");
      if (bytes.toString("base64") !== contents || bytes.length > 4_000_000)
        throw new Error("Invalid extension file contents.");
      if (pathWithin(slot.storage, filename))
        throw new Error("Extension storage writes must execute inside the OS sandbox.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return this.uiRequest(
        slot,
        "documents.writeFile",
        { relativePath: path.relative(slot.cwd, filename), contents: text },
        signal,
      );
    }
    if (
      ["documents.open", "documents.save", "documents.show", "documents.language"].includes(method)
    ) {
      const filename = await this.resourcePath(slot, params.resource, method === "documents.open");
      if (!pathWithin(slot.cwd, filename))
        throw new Error("Editor document access is restricted to its workspace.");
      const relativePath = path.relative(slot.cwd, filename);
      if (method === "documents.open") {
        const snapshot = slot.snapshots.get(filename);
        if (snapshot) return snapshot;
        const result = record.parse(await this.uiRequest(slot, method, { relativePath }, signal));
        const document = {
          relativePath,
          contents: z.string().max(2_000_000).parse(result.contents),
          version: z.number().int().nonnegative().parse(result.version),
        };
        return (await this.snapshots(slot, [document]))[0];
      }
      return this.uiRequest(slot, method, { ...params, relativePath }, signal);
    }
    if (method === "documents.applyEdits") {
      const editorUri = z.string().max(4_096).parse(params.id);
      const filename = fileURLToPath(editorUri);
      if (!pathWithin(slot.cwd, filename))
        throw new Error("Text editor write escapes its workspace.");
      const snapshot = slot.snapshots.get(filename);
      if (!snapshot || params.versionId !== snapshot.version)
        throw new Error("The extension edit targets a stale document version.");
      return this.uiRequest(
        slot,
        method,
        {
          ...params,
          relativePath: path.relative(slot.cwd, filename),
          expectedContents: snapshot.contents,
        },
        signal,
      );
    }
    if (method === "documents.workspaceEdit") {
      const edit = z
        .object({
          edits: z
            .array(
              z
                .object({
                  resource: resourceSchema,
                  textEdit: z.unknown(),
                  versionId: z.number().optional(),
                })
                .passthrough(),
            )
            .max(1_000),
        })
        .parse(params.edit);
      const safe = [];
      for (const item of edit.edits) {
        const filename = await this.resourcePath(slot, item.resource, true);
        if (!pathWithin(slot.cwd, filename))
          throw new Error("Workspace edits may not modify extension packages or storage.");
        const snapshot = slot.snapshots.get(filename);
        if (!snapshot)
          throw new Error("Open and synchronize every workspace edit target before changing it.");
        if (item.versionId !== undefined && snapshot?.version !== item.versionId)
          throw new Error("A workspace edit targets a stale native document.");
        safe.push({
          relativePath: path.relative(slot.cwd, filename),
          edit: item.textEdit,
          expectedContents: snapshot?.contents,
        });
      }
      return this.uiRequest(slot, method, { edits: safe }, signal);
    }
    if (
      [
        "ui.message",
        "ui.quickPick",
        "ui.input",
        "configuration.update",
        "configuration.remove",
        "command",
        "editor.selections",
        "editor.reveal",
        "tree.reveal",
        "output.reveal",
        "documents.saveAll",
        "debug.start",
        "debug.stop",
      ].includes(method)
    ) {
      return this.uiRequest(slot, method, params, signal);
    }
    if (method === "workspace.exists") {
      const includes = z.array(z.string().max(4_096)).max(128).parse(params.includes);
      for (const include of includes) {
        if (/[?*{[]/.test(include))
          throw new Error(
            "Glob workspace activation requires the native workspace search adapter.",
          );
        if (
          await this.workspacePath(slot, include).then(
            () => true,
            () => false,
          )
        )
          return true;
      }
      return false;
    }
    throw new Error(`Synara does not support extension operation ${method}.`);
  }
  async runtimeRequest(
    owner: string,
    input: EditorExtensionRuntimeInput,
    signal?: AbortSignal,
  ): Promise<EditorExtensionRuntimeResult> {
    if (this.disposed) throw new Error("Extensions are shutting down.");
    signal?.throwIfAborted();
    if (input.operation === "start")
      return this.snapshot(await this.start(owner, input.cwd, input.documents ?? []));
    // A manager-driven permission change can already have stopped this host.
    // Existing slots still go through the connection ownership check below.
    if (input.operation === "stop" && input.hostId && !this.slots.has(input.hostId)) {
      return { hostId: input.hostId, status: "stopped", sequence: 0, events: [] };
    }
    const slot = this.own(owner, input);
    if (path.resolve(input.cwd) !== slot.cwd && (await realpath(input.cwd)) !== slot.cwd)
      throw new Error("Extension host workspace does not match the request.");
    switch (input.operation) {
      case "poll":
        return this.snapshot(slot, input.after ?? 0);
      case "respond": {
        if (input.requestId === undefined)
          throw new Error("Native extension response identifier is required.");
        const pending = slot.pending.get(input.requestId);
        if (!pending) throw new Error("Native extension request is no longer pending.");
        if (input.error) pending.reject(new Error(input.error));
        else
          pending.resolve(
            input.responseJson === undefined ? undefined : JSON.parse(input.responseJson),
          );
        return this.snapshot(slot, input.after ?? slot.sequence);
      }
      case "stop":
        await this.stop(slot);
        return this.snapshot(slot, input.after ?? 0);
      case "restart":
        await this.stop(slot);
        return this.snapshot(await this.start(owner, input.cwd, input.documents ?? []));
      case "sync": {
        if (!slot.connection || slot.state !== "running")
          throw new Error("Extension host is not ready.");
        const documents = await this.snapshots(slot, input.documents ?? []);
        await slot.connection.request("documents", { documents }, signal);
        for (const languageId of new Set(documents.map((document) => document.languageId)))
          await slot.connection.request("activate", { event: `onLanguage:${languageId}` }, signal);
        return this.snapshot(slot, input.after ?? slot.sequence);
      }
      case "request": {
        if (!slot.connection || slot.state !== "running")
          throw new Error("Extension host is not ready.");
        const method = required(input.method, "Extension operation");
        const params = record.parse(JSON.parse(input.paramsJson ?? "{}"));
        if (method === "language" || (method === "state" && params.relativePath !== undefined)) {
          params.path = await this.workspacePath(slot, z.string().parse(params.relativePath), true);
          if (method === "language") z.number().int().nonnegative().parse(params.handle);
        }
        if (method === "activate" && params.id) {
          const id = extensionId(z.string().parse(params.id));
          const enabled = await this.manager.executableExtensions(slot.cwd);
          if (!enabled.some((entry) => entry.entry.id === id))
            throw new Error("Extension activation was not authorized.");
        }
        return this.snapshot(
          slot,
          input.after ?? slot.sequence,
          await slot.connection.request(method, params, signal),
        );
      }
    }
  }
  private async stop(slot: RuntimeSlot): Promise<void> {
    slot.state = "stopping";
    slot.abort.abort(new Error("Extension host stopped by Synara."));
    for (const pending of [...slot.pending.values()])
      pending.reject(new Error("Extension host is stopping."));
    await slot.flight;
    await slot.connection?.stop();
    slot.state = "stopped";
    this.slots.delete(slot.id);
  }
  async stopAll(): Promise<void> {
    this.generation++;
    await Promise.allSettled(this.starts.values());
    const results = await Promise.allSettled(
      [...this.slots.values()].map((slot) => this.stop(slot)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Some extension processes did not finish cleanup.",
      );
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.sweep);
    await this.stopAll();
    await this.manager.dispose();
    await this.storageWrites;
  }
}
