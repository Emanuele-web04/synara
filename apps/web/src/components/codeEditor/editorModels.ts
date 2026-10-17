// FILE: editorModels.ts
// Purpose: One engine text model per native document session, shared by the
//          file, diff and preview surfaces, plus the typed bridge to the
//          server's language service and the multi-file edit transaction.
// Layer: Web editor runtime
// Exports: acquireEditorModel, ensureEditorModels, requestIntelligence,
//          applyEditorEdits, editor URI/location helpers.

import * as monaco from "monaco-editor/editor/editor.api";
import type {
  EditorDocument,
  EditorFileEdits,
  EditorIntelligenceInput,
  EditorIntelligenceResult,
  EditorLocation,
} from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";
import {
  getWorkspaceEditorSession,
  getUnsavedWorkspaceEditorDocuments,
  type WorkspaceEditorSession,
} from "~/lib/workspaceEditorSession";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { resolveWorkspaceFileEditorReadOnlyReason } from "~/lib/workspaceFileEditor";
import { editorLanguageForPath } from "./editorHighlighting";
import { INTELLIGENCE_LANGUAGES } from "./editorProviders";

// A released model stays warm this long so reopening the file keeps its undo
// history; dirty or saving sessions are never disposed.
const IDLE_MODEL_DISPOSE_MS = 60_000;
// A remembered reveal target that no surface consumed (the open was declined
// or redirected) must not jump a later open of that file.
const PENDING_LOCATION_TTL_MS = 15_000;
// Peek views render other workspace files inside a surface; the files a
// document keeps loaded for that are bounded like a language request.
const MAX_DEPENDENCY_MODELS = 64;

export interface EditorModelEntry {
  model: monaco.editor.ITextModel;
  client: QueryClient;
  cwd: string | null;
  relativePath: string;
  session: WorkspaceEditorSession | null;
  /** Every holder: surfaces, peek dependencies and edit transactions. */
  references: number;
  /** Holders that show the model; peek dependencies are released when the last one closes. */
  surfaces: number;
  sourceVersion: number;
  viewStates: Map<string, monaco.editor.ICodeEditorViewState>;
  listeners: Set<(value: string) => void>;
  statusListeners: Set<(message: string | null) => void>;
  status: string | null;
  /** Models of other files this document holds for peek views; released when its last surface closes. */
  dependencies: Map<string, () => void>;
  /** Peek-model loads in flight, so concurrent requests share one read. */
  loading: Map<string, Promise<void>>;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  dispose: () => void;
}
const registries = new WeakMap<
  QueryClient,
  { id: number; entries: Map<string, EditorModelEntry> }
>();
const entriesByUri = new Map<string, EditorModelEntry>();
const pendingLocations = new Map<string, { range: monaco.IRange; at: number }>();
let nextRegistry = 0;
let nextStandalone = 0;
function registry(client: QueryClient) {
  let value = registries.get(client);
  if (!value) {
    value = { id: ++nextRegistry, entries: new Map() };
    registries.set(client, value);
  }
  return value;
}
export function editorUri(client: QueryClient, cwd: string | null, relativePath: string) {
  return monaco.Uri.from({
    scheme: "synara-workspace",
    authority: String(registry(client).id),
    path: `/${relativePath.replaceAll("\\", "/")}`,
    query: cwd ?? "",
  });
}
export function editorEntry(model: monaco.editor.ITextModel) {
  return entriesByUri.get(model.uri.toString());
}
export function entryForUri(uri: monaco.Uri) {
  return entriesByUri.get(uri.toString());
}
export function setEditorServiceStatus(entry: EditorModelEntry, message: string | null) {
  if (entry.status === message) return;
  entry.status = message;
  entry.statusListeners.forEach((listener) => listener(message));
}
export function supportsProjectIntelligence(entry: EditorModelEntry) {
  return (
    entry.cwd !== null &&
    (INTELLIGENCE_LANGUAGES as readonly string[]).includes(entry.model.getLanguageId()) &&
    entry.model.getValueLength() <= 2_000_000
  );
}

/** One Monaco text model per native document session. The session remains the only disk writer. */
export function acquireEditorModel(
  client: QueryClient,
  cwd: string | null,
  relativePath: string,
  value: string,
  sourceVersion: number,
  options: { surface?: boolean } = {},
) {
  const surface = options.surface ?? true;
  const store = registry(client);
  const key = cwd === null ? `standalone:${++nextStandalone}` : JSON.stringify([cwd, relativePath]);
  let entry = store.entries.get(key);
  if (!entry) {
    const session = cwd !== null ? getWorkspaceEditorSession(client, cwd, relativePath) : null;
    const snapshot = session?.getSnapshot();
    const model = monaco.editor.createModel(
      snapshot?.key ? snapshot.value : value,
      editorLanguageForPath(relativePath),
      cwd === null
        ? monaco.Uri.from({ scheme: "synara-standalone", path: `/${key}/${relativePath}` })
        : editorUri(client, cwd, relativePath),
    );
    model.updateOptions({ tabSize: 2, insertSpaces: true, trimAutoWhitespace: false });
    const owned: EditorModelEntry = {
      model,
      client,
      cwd,
      relativePath,
      session,
      references: 0,
      surfaces: 0,
      sourceVersion,
      viewStates: new Map(),
      listeners: new Set(),
      statusListeners: new Set(),
      status: null,
      dependencies: new Map(),
      loading: new Map(),
      dispose: () => undefined,
    };
    let changingFromSession = false;
    const unsubscribe = session?.subscribe(() => {
      const state = session.getSnapshot();
      if (!state.key || model.isDisposed()) return;
      if (state.value === model.getValue()) {
        owned.sourceVersion = state.version;
        return;
      }
      changingFromSession = true;
      try {
        // Reloads/discards deliberately reset history; ordinary cross-surface changes do not.
        if (state.version !== owned.sourceVersion) model.setValue(state.value);
        else replaceEditorText(model, state.value);
        owned.sourceVersion = state.version;
      } finally {
        changingFromSession = false;
      }
    });
    const change = model.onDidChangeContent(() => {
      if (changingFromSession) return;
      const contents = model.getValue();
      session?.change(contents);
      owned.listeners.forEach((listener) => listener(contents));
    });
    owned.dispose = () => {
      clearTimeout(owned.idleTimer);
      unsubscribe?.();
      change.dispose();
      store.entries.delete(key);
      entriesByUri.delete(model.uri.toString());
      pendingLocations.delete(model.uri.toString());
      model.dispose();
      owned.listeners.clear();
      owned.statusListeners.clear();
      releaseDependencies(owned);
    };
    entry = owned;
    store.entries.set(key, entry);
    entriesByUri.set(model.uri.toString(), entry);
  }
  entry.references++;
  if (surface) entry.surfaces++;
  clearTimeout(entry.idleTimer);
  let released = false;
  return {
    entry,
    release: () => {
      if (released) return;
      released = true;
      entry.references--;
      // Peeked files go with the last surface, not the last reference: two
      // documents peeking each other would otherwise hold each other forever.
      if (surface && --entry.surfaces === 0) releaseDependencies(entry);
      if (entry.references > 0) return;
      if (cwd === null) {
        entry.dispose();
        return;
      }
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        if (entry.references === 0 && !entry.session?.dirty && !entry.session?.saving)
          entry.dispose();
      }, IDLE_MODEL_DISPOSE_MS);
    },
  };
}

function releaseDependencies(entry: EditorModelEntry) {
  entry.dependencies.forEach((release) => release());
  entry.dependencies.clear();
}

/**
 * Loads the models of other workspace files so the engine's peek views and
 * reference trees can show them from this document. Unsaved buffers are shown
 * as they are; clean files are re-read through Synara's file API so the peek
 * matches the disk state the language service located. The models stay held
 * until this document's last surface closes. Files Synara treats as read-only
 * (truncated, symlinks, mixed line endings) are skipped.
 */
export async function ensureEditorModels(
  entry: EditorModelEntry,
  relativePaths: readonly string[],
): Promise<void> {
  if (!entry.cwd) return;
  await Promise.allSettled(
    [...new Set(relativePaths)]
      .filter((relativePath) => relativePath !== entry.relativePath)
      .map((relativePath) => loadDependencyModel(entry, relativePath)),
  );
}

function loadDependencyModel(entry: EditorModelEntry, relativePath: string): Promise<void> {
  const pending = entry.loading.get(relativePath);
  if (pending) return pending;
  const cwd = entry.cwd!;
  const task = (async () => {
    // Loads in flight count against the bound, so a burst of results cannot
    // all pass the check before the first read returns.
    if (
      !entry.dependencies.has(relativePath) &&
      entry.dependencies.size + entry.loading.size >= MAX_DEPENDENCY_MODELS
    )
      throw new Error("Too many files are held for peek views.");
    const session = getWorkspaceEditorSession(entry.client, cwd, relativePath);
    let contents = session.getSnapshot().value;
    if (!session.dirty && !session.saving) {
      // Cancel a read in flight for the pane first, as the session's reload does,
      // so this fetch is never deduplicated onto an older request.
      const readOptions = projectReadFileQueryOptions({ cwd, relativePath });
      await entry.client.cancelQueries({ queryKey: readOptions.queryKey, exact: true });
      const data = await entry.client.fetchQuery({ ...readOptions, staleTime: 0 });
      if (data.relativePath !== relativePath) throw new Error("The file resolved elsewhere.");
      const reason = resolveWorkspaceFileEditorReadOnlyReason(data);
      if (reason) throw new Error(reason);
      session.load(data);
      contents = session.getSnapshot().key ? session.getSnapshot().value : data.contents;
    }
    if (entry.model.isDisposed() || entry.surfaces === 0) throw new Error("The document closed.");
    if (!entry.dependencies.has(relativePath)) {
      const handle = acquireEditorModel(
        entry.client,
        cwd,
        relativePath,
        contents,
        session.getSnapshot().version,
        { surface: false },
      );
      entry.dependencies.set(relativePath, handle.release);
    }
  })().finally(() => entry.loading.delete(relativePath));
  entry.loading.set(relativePath, task);
  return task;
}

export function replaceEditorText(model: monaco.editor.ITextModel, value: string) {
  if (model.getValue() === value) return;
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
  model.pushStackElement();
}

export function offsetRange(
  model: monaco.editor.ITextModel,
  span: { start: number; length: number },
) {
  const start = model.getPositionAt(span.start),
    end = model.getPositionAt(span.start + span.length);
  return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
}
export function locationRange(location: EditorLocation) {
  return new monaco.Range(
    location.line + 1,
    location.character + 1,
    location.endLine + 1,
    location.endCharacter + 1,
  );
}
export function rememberEditorLocation(uri: monaco.Uri, range: monaco.IRange) {
  pendingLocations.set(uri.toString(), { range, at: Date.now() });
}
export function forgetEditorLocation(uri: monaco.Uri) {
  pendingLocations.delete(uri.toString());
}
export function takeEditorLocation(uri: monaco.Uri) {
  const key = uri.toString();
  const pending = pendingLocations.get(key);
  pendingLocations.delete(key);
  return pending && Date.now() - pending.at <= PENDING_LOCATION_TTL_MS ? pending.range : undefined;
}
/**
 * The snapshots a language request carries: the requesting document plus every
 * unsaved workspace buffer, so cross-file results see in-progress edits. Clean
 * buffers equal the disk copy the server already reads.
 */
export function workspaceDocuments(entry: EditorModelEntry): EditorDocument[] {
  const documents = new Map<string, EditorDocument>(
    (entry.cwd ? getUnsavedWorkspaceEditorDocuments(entry.client, entry.cwd) : []).map(
      (document) => [document.relativePath, document],
    ),
  );
  documents.set(entry.relativePath, {
    relativePath: entry.relativePath,
    contents: entry.model.getValue(),
    version: entry.model.getVersionId(),
  });
  // A large, unrelated text preview must not disable intelligence for a small code file.
  const relevant = [...documents.values()].filter(
    (document) =>
      document.relativePath === entry.relativePath ||
      /\.(?:[cm]?[jt]sx?|json)$/i.test(document.relativePath),
  );
  if (relevant.length > 64 || relevant.some((document) => document.contents.length > 2_000_000))
    throw new Error(
      "The open code snapshots exceed the language service's document limits. Editing and saving remain available.",
    );
  return relevant;
}
export async function requestIntelligence(
  entry: EditorModelEntry,
  operation: EditorIntelligenceInput["operation"],
  options: {
    offset?: number;
    length?: number;
    query?: string;
    newName?: string;
    completionSource?: string;
    token?: monaco.CancellationToken;
    signal?: AbortSignal;
  } = {},
): Promise<EditorIntelligenceResult | undefined> {
  if (!supportsProjectIntelligence(entry)) return undefined;
  const api = ensureNativeApi().editor;
  if (!api) {
    setEditorServiceStatus(
      entry,
      "This server does not provide editor intelligence. Editing and saving are still available.",
    );
    return undefined;
  }
  const version = entry.model.getVersionId();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const listener = options.token?.onCancellationRequested(cancel);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.token?.isCancellationRequested || options.signal?.aborted) controller.abort();
  try {
    const modelOptions = entry.model.getOptions();
    const result = await api.intelligence(
      {
        cwd: entry.cwd!,
        relativePath: entry.relativePath,
        documents: workspaceDocuments(entry),
        operation,
        offset: options.offset ?? 0,
        length: options.length ?? 0,
        tabSize: modelOptions.tabSize,
        insertSpaces: modelOptions.insertSpaces,
        ...(options.completionSource === undefined
          ? {}
          : { completionSource: options.completionSource }),
        ...(options.query === undefined ? {} : { query: options.query }),
        ...(options.newName === undefined ? {} : { newName: options.newName }),
      },
      { signal: controller.signal },
    );
    if (
      controller.signal.aborted ||
      entry.model.isDisposed() ||
      entry.model.getVersionId() !== version ||
      result.version !== version
    )
      return undefined;
    setEditorServiceStatus(entry, null);
    return result;
  } catch (error) {
    if (controller.signal.aborted) return undefined;
    setEditorServiceStatus(
      entry,
      error instanceof Error
        ? error.message
        : "Language service failed. Editing is still available.",
    );
    throw error;
  } finally {
    listener?.dispose();
    options.signal?.removeEventListener("abort", cancel);
  }
}

/** Prepare every target before any mutation; reject stale buffers, read-only formats and conflicts. */
async function prepareEditorEdits(source: EditorModelEntry, files: readonly EditorFileEdits[]) {
  if (!source.cwd) throw new Error("A workspace is required for project edits.");
  const acquired: ReturnType<typeof acquireEditorModel>[] = [];
  try {
    const paths = new Set<string>();
    const prepared = await Promise.allSettled(
      files.map(async (file) => {
        if (
          file.relativePath
            .split(/[\\/]/)
            .some((part) => part === ".." || part === ".git" || part === "node_modules") ||
          /^(?:[\\/]|[A-Za-z]:)/.test(file.relativePath)
        )
          throw new Error("Edit target is not an editable workspace path.");
        if (paths.has(file.relativePath))
          throw new Error("Language service returned duplicate edit targets.");
        paths.add(file.relativePath);
        // Re-read every target so a changed symlink, encoding, or disk version cannot bypass native conflict checks.
        // Cancel a read already in flight for the pane first, as the session's own reload does,
        // so this fetch is never deduplicated onto an older request.
        const readOptions = projectReadFileQueryOptions({
          cwd: source.cwd,
          relativePath: file.relativePath,
        });
        await source.client.cancelQueries({ queryKey: readOptions.queryKey, exact: true });
        const data = await source.client.fetchQuery({ ...readOptions, staleTime: 0 });
        const reason = resolveWorkspaceFileEditorReadOnlyReason(data);
        if (reason || data.relativePath !== file.relativePath)
          throw new Error(reason ?? "Edit target resolved to a different file.");
        const session = getWorkspaceEditorSession(source.client, source.cwd!, file.relativePath);
        session.load(data);
        let target = registry(source.client).entries.get(
          JSON.stringify([source.cwd, file.relativePath]),
        );
        if (!target) {
          const handle = acquireEditorModel(
            source.client,
            source.cwd,
            file.relativePath,
            session.getSnapshot().value,
            session.getSnapshot().version,
            { surface: false },
          );
          acquired.push(handle);
          target = handle.entry;
        }
        return { target, file };
      }),
    );
    const failure = prepared.find((item) => item.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const targets = prepared.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
    validateEditorEditTargets(targets);
    return targets;
  } finally {
    acquired.forEach((handle) => handle.release());
  }
}

function validateEditorEditTargets(
  targets: readonly { target: EditorModelEntry; file: EditorFileEdits }[],
) {
  for (const { target, file } of targets) {
    if (
      target.session?.getSnapshot().conflict ||
      !target.session?.getSnapshot().format ||
      target.model.getValue() !== file.expectedContents
    ) {
      throw new Error(
        `${file.relativePath} changed while the edit was being prepared. Nothing was changed; run the action again.`,
      );
    }
    const ordered = [...file.edits].sort((a, b) => a.start - b.start);
    let end = 0;
    for (const edit of ordered) {
      if (edit.start < end || edit.start + edit.length > file.expectedContents.length)
        throw new Error("Language service returned overlapping or invalid edits.");
      end = edit.start + edit.length;
    }
  }
}

export async function applyEditorEdits(
  source: EditorModelEntry,
  files: readonly EditorFileEdits[],
) {
  const targets = await prepareEditorEdits(source, files);
  // Recheck after awaiting preparation: another surface can edit in that microtask gap.
  // No await between this validation and mutation; native writes still check disk versions.
  validateEditorEditTargets(targets);
  for (const { target, file } of targets) {
    target.model.pushStackElement();
    target.model.pushEditOperations(
      [],
      file.edits.map((edit) => ({ range: offsetRange(target.model, edit), text: edit.newText })),
      () => null,
    );
    target.model.pushStackElement();
  }
}
