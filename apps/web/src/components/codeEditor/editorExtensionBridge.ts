import type { QueryClient } from "@tanstack/react-query";
import type {
  EditorDocument,
  EditorFileEdits,
  EditorExtensionRuntimeInput,
  EditorExtensionRuntimeResult,
} from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import {
  getWorkspaceEditorSession,
  getUnsavedWorkspaceEditorDocuments,
} from "~/lib/workspaceEditorSession";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { resolveWorkspaceFileEditorReadOnlyReason } from "~/lib/workspaceFileEditor";
import { acquireEditorModel, applyEditorEdits, type EditorModelEntry } from "./editorModels";
import type { EditorActionRow } from "./EditorActionPicker";
import { monaco } from "./editorRuntime";
import {
  EMPTY_EXTENSION_CONTRIBUTIONS,
  ExtensionContributions,
  type ExtensionContributionsSnapshot,
} from "./extensionContributions";
import { getEditorDebugStore } from "./editorDebugStore";
import { extensionDebugBackend } from "./extensionDebugBackend";
import {
  registerNativeExtensionProviders,
  applyNativeExtensionDiagnostics,
} from "./extensionLanguageProviders";

type Provider = {
  handle: number;
  kind: string;
  selector: unknown;
  label: string;
  metadata: readonly unknown[];
};
export type ExtensionInteraction = {
  id: number;
  method: "ui.message" | "ui.input" | "ui.quickPick";
  params: Record<string, unknown>;
  items: readonly ExtensionChoice[];
};
export type ExtensionChoice = { handle: number; label: string; detail?: string };
type BridgeState = {
  phase: EditorExtensionRuntimeResult["status"];
  error: string | null;
  interactions: readonly ExtensionInteraction[];
  output: readonly string[];
  contributions: ExtensionContributionsSnapshot;
};
type Attachment = { entry: EditorModelEntry; editable: boolean; owner: object };
const stores = new WeakMap<QueryClient, Map<string, EditorExtensionBridge>>();

export function extensionRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid extension response object.");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid extension integer.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_000_000)
    throw new Error("Invalid extension text.");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("Invalid extension list.");
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Extension operation failed.";
}
function choices(value: unknown): ExtensionChoice[] {
  return list(value).map((raw) => {
    const item = extensionRecord(raw);
    return {
      handle: integer(item.handle),
      label: text(item.label ?? item.title),
      ...(typeof item.description === "string" ? { detail: item.description } : {}),
    };
  });
}
/** Reject clamped, reversed or overlapping extension edits before touching any buffer. */
export function extensionTextEdits(
  model: monaco.editor.ITextModel,
  value: unknown,
): EditorFileEdits["edits"] {
  const edits = list(value)
    .map((raw) => {
      const edit = extensionRecord(raw),
        range = extensionRecord(edit.range);
      const requested = new monaco.Range(
        integer(range.startLineNumber),
        integer(range.startColumn),
        integer(range.endLineNumber),
        integer(range.endColumn),
      );
      if (
        requested.startLineNumber !== range.startLineNumber ||
        requested.startColumn !== range.startColumn ||
        requested.endLineNumber !== range.endLineNumber ||
        requested.endColumn !== range.endColumn ||
        !monaco.Range.equalsRange(requested, model.validateRange(requested))
      )
        throw new Error("Extension returned an invalid edit range.");
      const start = model.getOffsetAt(requested.getStartPosition());
      return {
        start,
        length: model.getOffsetAt(requested.getEndPosition()) - start,
        newText: text(edit.text),
      };
    })
    .sort((a, b) => a.start - b.start);
  let end = 0;
  for (const edit of edits) {
    if (edit.start < end) throw new Error("Extension returned overlapping edits.");
    end = edit.start + edit.length;
  }
  return edits;
}

/** One opt-in host per native client/workspace, shared by file, preview and diff surfaces. */
export class EditorExtensionBridge {
  private state: BridgeState = {
    phase: "stopped",
    error: null,
    interactions: [],
    output: [],
    contributions: EMPTY_EXTENSION_CONTRIBUTIONS,
  };
  readonly contributions = new ExtensionContributions(
    (method, params) => this.invoke(method, params),
    (contributions) => this.update({ contributions }),
  );
  private readonly listeners = new Set<() => void>();
  private readonly attachments = new Set<Attachment>();
  private readonly revisions = new Map<string, { contents: string; version: number }>();
  private readonly nativeRequests = new Set<number>();
  private readonly pickItems = new Map<number, ExtensionChoice[]>();
  private readonly providers = new Map<number, Provider>();
  private languageRegistrations: monaco.IDisposable[] = [];
  private readonly diagnosticOwners = new Set<string>();
  private commands: string[] = [];
  private hostId: string | undefined;
  private sequence = 0;
  private generation = 0;
  private startup: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private syncQueue: Promise<unknown> = Promise.resolve();
  private readonly live = new Set<AbortController>();
  constructor(
    readonly client: QueryClient,
    readonly cwd: string,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<BridgeState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private failure(error: unknown) {
    this.update({ error: errorMessage(error) });
  }
  ownsInteraction(owner: object | null): boolean {
    return [...this.attachments][0]?.owner === owner;
  }
  retain(entry: EditorModelEntry, editable: boolean, owner: object = entry): () => void {
    const attachment = { entry, editable, owner };
    this.attachments.add(attachment);
    const changed = entry.model.onDidChangeContent(() => {
      if (this.state.phase !== "running") return;
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(
        () => void this.sync().catch((error: unknown) => this.failure(error)),
        80,
      );
    });
    this.update({});
    return () => {
      changed.dispose();
      this.attachments.delete(attachment);
      this.update({});
      queueMicrotask(() => {
        if (this.attachments.size === 0)
          void this.stop().catch((error: unknown) => this.failure(error));
      });
    };
  }
  private source(): EditorModelEntry {
    const source = [...this.attachments].find(
      (item) => item.editable && !item.entry.model.isDisposed(),
    )?.entry;
    if (!source) throw new Error("Open an editable workspace document to apply extension changes.");
    return source;
  }
  private document(relativePath: string, contents: string): EditorDocument {
    const previous = this.revisions.get(relativePath);
    const version = previous ? previous.version + Number(previous.contents !== contents) : 1;
    this.revisions.set(relativePath, { contents, version });
    return { relativePath, contents, version };
  }
  private documents(): EditorDocument[] {
    const values = new Map<string, string>();
    for (const item of getUnsavedWorkspaceEditorDocuments(this.client, this.cwd))
      values.set(item.relativePath, item.contents);
    for (const { entry } of this.attachments)
      if (!entry.model.isDisposed()) values.set(entry.relativePath, entry.model.getValue());
    if (
      values.size > 64 ||
      [...values.values()].reduce((size, value) => size + value.length, 0) > 4_000_000
    )
      throw new Error("Open extension documents exceed the snapshot limit.");
    return [...values].map(([relativePath, contents]) => this.document(relativePath, contents));
  }
  private async request(
    input: Omit<EditorExtensionRuntimeInput, "cwd">,
  ): Promise<EditorExtensionRuntimeResult> {
    const api = ensureNativeApi().editor?.extensionRuntime;
    if (!api) throw new Error("This server does not provide Code-OSS extension execution.");
    const controller = new AbortController();
    this.live.add(controller);
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      return await api({ ...input, cwd: this.cwd }, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
      this.live.delete(controller);
    }
  }
  private accept(result: EditorExtensionRuntimeResult) {
    if (this.hostId && result.hostId !== this.hostId) return;
    this.hostId = result.hostId;
    this.update({ phase: result.status });
    if (result.events.length && result.events[0]!.sequence > this.sequence + 1)
      throw new Error(
        "Extension events were lost. Restart extensions to restore synchronized state.",
      );
    for (const event of result.events) {
      if (event.sequence <= this.sequence) continue;
      this.sequence = event.sequence;
      const body: unknown = JSON.parse(event.bodyJson);
      if (this.contributions.consume(event.event, body)) continue;
      if (event.event === "providers") {
        this.providers.clear();
        for (const value of list(body)) {
          const provider = extensionRecord(value);
          const metadata = Array.isArray(provider.metadata) ? provider.metadata : [];
          this.providers.set(integer(provider.handle), {
            handle: integer(provider.handle),
            kind: text(provider.kind),
            selector: provider.selector,
            metadata,
            label:
              typeof metadata.at(-1) === "string" ? String(metadata.at(-1)) : "Extension formatter",
          });
        }
        this.languageRegistrations.forEach((registration) => registration.dispose());
        this.languageRegistrations = registerNativeExtensionProviders(this, [
          ...this.providers.values(),
        ]);
      } else if (event.event === "diagnostics") {
        const data = extensionRecord(body);
        this.diagnosticOwners.add(text(data.owner));
        applyNativeExtensionDiagnostics(this, body);
      } else if (event.event === "commands") this.commands = list(body).map(text);
      else if (
        ["error", "failure", "cleanupError", "activationError", "extensionError"].includes(
          event.event,
        )
      ) {
        const details = typeof body === "string" ? body : JSON.stringify(body);
        this.update({ error: details.slice(0, 4_096) });
      } else if (event.event === "stdout" || event.event === "stderr") {
        this.update({ output: [...this.state.output, text(body).slice(-4_096)].slice(-32) });
      } else if (event.event === "quickPick.items") {
        const data = extensionRecord(body),
          instance = integer(data.instance),
          items = choices(data.items);
        this.pickItems.set(instance, items);
        this.update({
          interactions: this.state.interactions.map((item) =>
            item.params.instance === instance ? { ...item, items } : item,
          ),
        });
      } else if (event.event === "nativeRequest") {
        const data = extensionRecord(body),
          id = integer(data.id);
        if (!this.nativeRequests.has(id)) {
          this.nativeRequests.add(id);
          void this.native(id, text(data.method), extensionRecord(data.params)).catch(
            (error: unknown) =>
              this.answer(id, undefined, errorMessage(error)).catch((cause: unknown) =>
                this.failure(cause),
              ),
          );
        }
      }
    }
  }
  private schedulePoll(generation: number) {
    clearTimeout(this.pollTimer);
    if (
      generation !== this.generation ||
      !this.hostId ||
      !["starting", "running"].includes(this.state.phase)
    )
      return;
    this.pollTimer = setTimeout(() => {
      const hostId = this.hostId;
      if (!hostId || generation !== this.generation) return;
      void this.request({ operation: "poll", hostId, after: this.sequence })
        .then((result) => {
          if (generation === this.generation) {
            this.accept(result);
            this.schedulePoll(generation);
          }
        })
        .catch((error: unknown) => {
          if (generation === this.generation) {
            this.failure(error);
            void this.stop().catch((cause: unknown) => this.failure(cause));
          }
        });
    }, 250);
  }
  start(): Promise<void> {
    if (this.startup) return this.startup;
    if (this.state.phase === "running") return Promise.resolve();
    this.startup = (async () => {
      if (this.hostId) await this.stop();
      const generation = ++this.generation;
      this.sequence = 0;
      this.providers.clear();
      this.commands = [];
      this.revisions.clear();
      this.nativeRequests.clear();
      this.update({ phase: "starting", error: null, interactions: [] });
      const result = await this.request({ operation: "start", documents: this.documents() });
      if (generation !== this.generation) {
        await this.request({ operation: "stop", hostId: result.hostId });
        return;
      }
      this.accept(result);
      this.schedulePoll(generation);
      await new Promise<void>((resolve, reject) => {
        const inspect = () => {
          if (
            generation !== this.generation ||
            ["failed", "unsupported", "not-built", "stopped"].includes(this.state.phase)
          ) {
            cleanup();
            reject(new Error(this.state.error ?? "Extension startup did not succeed."));
          } else if (this.state.phase === "running") {
            cleanup();
            resolve();
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Code-OSS extensions did not start within the startup deadline."));
        }, 35_000);
        const unsubscribe = this.subscribe(inspect);
        const cleanup = () => {
          clearTimeout(timer);
          unsubscribe();
        };
        inspect();
      });
    })()
      .catch((error: unknown) => {
        this.update({ phase: "failed", error: errorMessage(error) });
        throw error;
      })
      .finally(() => {
        this.startup = undefined;
      });
    return this.startup;
  }
  async provide(
    entry: EditorModelEntry,
    handle: number,
    params: Record<string, unknown>,
    token: monaco.CancellationToken,
  ): Promise<unknown> {
    if (this.state.phase !== "running" || token.isCancellationRequested) return undefined;
    const version = entry.model.getVersionId();
    await this.sync();
    if (token.isCancellationRequested) return undefined;
    const result = await this.invoke("language", {
      ...params,
      handle,
      relativePath: entry.relativePath,
    });
    if (
      token.isCancellationRequested ||
      entry.model.isDisposed() ||
      entry.model.getVersionId() !== version
    )
      return undefined;
    return result;
  }
  async stop(): Promise<void> {
    this.contributions.clear();
    this.languageRegistrations.forEach((registration) => registration.dispose());
    this.languageRegistrations = [];
    for (const owner of this.diagnosticOwners)
      applyNativeExtensionDiagnostics(this, { owner, entries: [] });
    this.diagnosticOwners.clear();
    this.generation++;
    clearTimeout(this.pollTimer);
    clearTimeout(this.syncTimer);
    for (const controller of this.live) controller.abort();
    const hostId = this.hostId;
    this.update({ phase: "stopping", interactions: [] });
    if (hostId) await this.request({ operation: "stop", hostId });
    this.hostId = undefined;
    this.providers.clear();
    this.commands = [];
    this.pickItems.clear();
    this.update({ phase: "stopped" });
  }
  private sync(): Promise<void> {
    const operation = this.syncQueue.then(async () => {
      if (this.state.phase !== "running" || !this.hostId) return;
      // Poll owns event delivery. Mutation replies intentionally request no replay.
      await this.request({ operation: "sync", hostId: this.hostId, documents: this.documents() });
    });
    this.syncQueue = operation.catch(() => undefined);
    return operation;
  }
  private async invoke(
    method: "activate" | "language" | "command" | "state" | "debug" | "tree" | "ui",
    params: unknown,
  ): Promise<unknown> {
    if (!this.hostId || this.state.phase !== "running")
      throw new Error("Start approved extensions before invoking their tools.");
    const result = await this.request({
      operation: "request",
      hostId: this.hostId,
      method,
      paramsJson: JSON.stringify(params),
    });
    return result.resultJson === undefined ? undefined : JSON.parse(result.resultJson);
  }
  debug(params: Record<string, unknown>): Promise<unknown> {
    return this.invoke("debug", params);
  }
  async format(entry: EditorModelEntry, handle: number): Promise<void> {
    if (![...this.attachments].some((item) => item.entry === entry && item.editable))
      throw new Error("This editor surface is read-only.");
    const version = entry.model.getVersionId(),
      expectedContents = entry.model.getValue();
    await this.sync();
    const value = await this.invoke("language", {
      handle,
      relativePath: entry.relativePath,
      options: {
        tabSize: entry.model.getOptions().tabSize,
        insertSpaces: entry.model.getOptions().insertSpaces,
      },
    });
    if (
      entry.model.isDisposed() ||
      entry.model.getVersionId() !== version ||
      entry.model.getValue() !== expectedContents
    )
      throw new Error(
        "The document changed while the extension was formatting. Nothing was changed.",
      );
    if (value == null) return;
    await applyEditorEdits(entry, [
      {
        relativePath: entry.relativePath,
        expectedContents,
        edits: extensionTextEdits(entry.model, value),
      },
    ]);
  }
  actionRows(
    entry: EditorModelEntry,
    show: (title: string, rows: EditorActionRow[]) => void,
  ): EditorActionRow[] {
    const running = this.state.phase === "running";
    const rows: EditorActionRow[] = [
      {
        id: "extensions:state",
        label: running ? "Restart approved extensions" : "Start approved extensions",
        detail: "Code-OSS",
        run: async () => {
          if (running) await this.stop();
          await this.start();
        },
      },
    ];
    if (this.hostId)
      rows.push({ id: "extensions:stop", label: "Stop extensions", run: () => this.stop() });
    if (running) {
      rows.push({
        id: "extensions:views",
        label: "Open extension view…",
        run: () => this.contributions.views(show),
      });
      rows.push({
        id: "extensions:format",
        label: "Format with extension…",
        run: async () => {
          await this.sync();
          const result = extensionRecord(
            await this.invoke("state", { relativePath: entry.relativePath }),
          );
          show(
            "Extension formatters",
            list(result.providers)
              .map(extensionRecord)
              .filter((provider) => provider.kind === "format")
              .map((provider) => {
                const metadata = list(provider.metadata),
                  label = metadata.at(-1);
                return {
                  id: String(integer(provider.handle)),
                  label: typeof label === "string" ? label : "Extension formatter",
                  run: () => this.format(entry, integer(provider.handle)),
                };
              }),
          );
        },
      });
      rows.push({
        id: "extensions:debug",
        label: "Start extension debugger…",
        detail: ".vscode/launch.json",
        run: async () => {
          await this.sync();
          const configurations = list(await this.debug({ operation: "configurations" }));
          show(
            "Extension debug configurations",
            configurations.map((value) => {
              const configuration = extensionRecord(value);
              const id = text(configuration.id);
              return {
                id,
                label: text(configuration.name),
                detail: text(configuration.type),
                run: async () => {
                  await getEditorDebugStore(this.client, this.cwd).start(
                    {
                      request: "launch",
                      program: entry.relativePath,
                      args: [],
                      port: 0,
                      stopOnEntry: false,
                    },
                    extensionDebugBackend(this, id, entry.relativePath),
                  );
                },
              };
            }),
          );
        },
      });
      rows.push({
        id: "extensions:commands",
        label: "Run extension command…",
        run: () =>
          show(
            "Extension commands",
            this.commands.map((id) => ({
              id,
              label: id,
              run: async () => {
                await this.sync();
                await this.invoke("activate", { event: `onCommand:${id}` });
                await this.invoke("command", { id });
              },
            })),
          ),
      });
    }
    return rows;
  }
  async answer(id: number, value?: unknown, error?: string): Promise<void> {
    if (!this.hostId) return;
    await this.request({
      operation: "respond",
      hostId: this.hostId,
      requestId: id,
      ...(value === undefined ? {} : { responseJson: JSON.stringify(value) }),
      ...(error === undefined ? {} : { error }),
    });
    this.update({ interactions: this.state.interactions.filter((item) => item.id !== id) });
  }
  private async target(relativePath: string) {
    if (
      !relativePath ||
      relativePath
        .split(/[\\/]/)
        .some((part) => part === ".." || part === ".git" || part === "node_modules") ||
      /^(?:[\\/]|[A-Za-z]:)/.test(relativePath)
    )
      throw new Error("Extension target is not an editable workspace path.");
    const file = await this.client.fetchQuery({
      ...projectReadFileQueryOptions({ cwd: this.cwd, relativePath }),
      staleTime: 0,
    });
    const reason = resolveWorkspaceFileEditorReadOnlyReason(file);
    if (reason || file.relativePath !== relativePath)
      throw new Error(reason ?? "Extension target resolved to another path.");
    const session = getWorkspaceEditorSession(this.client, this.cwd, relativePath);
    session.load(file);
    return acquireEditorModel(
      this.client,
      this.cwd,
      relativePath,
      session.getSnapshot().value,
      session.getSnapshot().version,
    );
  }
  private async native(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "ui.message" || method === "ui.input" || method === "ui.quickPick") {
      const options = params.options === undefined ? {} : extensionRecord(params.options);
      if (
        method === "ui.message" &&
        options.modal !== true &&
        list(params.items ?? []).length === 0
      ) {
        this.contributions.notify(params);
        await this.answer(id);
        return;
      }
      if (options.canPickMany || options.canSelectMany || params.validateInput)
        throw new Error("This extension requires an unsupported picker or input-validation API.");
      const items =
        method === "ui.message"
          ? choices(params.items ?? [])
          : method === "ui.quickPick"
            ? (this.pickItems.get(integer(params.instance)) ?? [])
            : [];
      this.update({ interactions: [...this.state.interactions, { id, method, params, items }] });
      return;
    }
    const source = this.source();
    if (method === "documents.saveAll") {
      let saved = true;
      for (const { entry, editable } of this.attachments)
        if (editable && entry.session && !(await entry.session.flush())) saved = false;
      await this.answer(id, saved);
      return;
    }
    if (
      ["documents.open", "documents.save", "documents.writeFile", "documents.applyEdits"].includes(
        method,
      )
    ) {
      const relativePath = text(params.relativePath),
        target = await this.target(relativePath);
      try {
        const entry = target.entry;
        if (method === "documents.open")
          await this.answer(id, this.document(relativePath, entry.model.getValue()));
        else if (method === "documents.save")
          await this.answer(id, (await entry.session?.flush()) ?? false);
        else {
          const expectedContents =
            method === "documents.applyEdits"
              ? text(params.expectedContents)
              : entry.model.getValue();
          if (entry.model.getValue() !== expectedContents)
            throw new Error("Extension edit targets a stale document.");
          if (method === "documents.writeFile" && entry.session?.dirty)
            throw new Error(
              "Extension file writes cannot overwrite an unsaved draft. Save the document before retrying.",
            );
          const edits =
            method === "documents.applyEdits"
              ? extensionTextEdits(entry.model, params.edits)
              : [{ start: 0, length: expectedContents.length, newText: text(params.contents) }];
          await applyEditorEdits(source, [{ relativePath, expectedContents, edits }]);
          await this.answer(id, true);
        }
      } finally {
        target.release();
      }
      return;
    }
    if (method === "documents.workspaceEdit") {
      const handles: ReturnType<typeof acquireEditorModel>[] = [];
      try {
        const grouped = new Map<
          string,
          { target: EditorModelEntry; expectedContents: string; raw: unknown[] }
        >();
        for (const value of list(params.edits)) {
          const item = extensionRecord(value),
            relativePath = text(item.relativePath);
          let group = grouped.get(relativePath);
          if (!group) {
            const handle = await this.target(relativePath);
            handles.push(handle);
            group = {
              target: handle.entry,
              expectedContents: handle.entry.model.getValue(),
              raw: [],
            };
            grouped.set(relativePath, group);
          }
          if (
            item.expectedContents !== undefined &&
            text(item.expectedContents) !== group.expectedContents
          )
            throw new Error("Extension workspace edit targets a stale document.");
          group.raw.push(item.edit);
        }
        const files = [...grouped].map(([relativePath, group]) => ({
          relativePath,
          expectedContents: group.expectedContents,
          edits: extensionTextEdits(group.target.model, group.raw),
        }));
        await applyEditorEdits(source, files);
        await this.answer(id, true);
      } finally {
        handles.forEach((handle) => handle.release());
      }
      return;
    }
    throw new Error(`Synara does not yet expose ${method} through this editor surface.`);
  }
}
export function getEditorExtensionBridge(client: QueryClient, cwd: string): EditorExtensionBridge {
  let workspaces = stores.get(client);
  if (!workspaces) {
    workspaces = new Map();
    stores.set(client, workspaces);
  }
  let bridge = workspaces.get(cwd);
  if (!bridge) {
    bridge = new EditorExtensionBridge(client, cwd);
    workspaces.set(cwd, bridge);
  }
  return bridge;
}
