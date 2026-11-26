import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  CANVAS_DEFAULT_VIEWPORT,
  CANVAS_MAX_ASSET_BYTES,
  CANVAS_MAX_COMMENT_MESSAGES,
  CANVAS_MAX_COMMENT_THREADS,
  CANVAS_MAX_PAGE_DIVIDERS,
  CANVAS_MAX_PAGES,
  CanvasAssetUpload,
  CanvasId,
  CanvasResource,
  CanvasWork as CanvasWorkSchema,
  type CanvasAsset,
  type CanvasAssetData,
  type CanvasBindChatInput,
  type CanvasChangedEvent,
  type CanvasCommentAuthor,
  type CanvasCommentChangeInput,
  type CanvasCreateInput,
  type CanvasDuplicateInput,
  type CanvasEditLayersInput,
  type CanvasExportEntry,
  type CanvasFolder,
  type CanvasListInput,
  type CanvasListResult,
  type CanvasPage,
  type CanvasPageChangeInput,
  type CanvasPageLayoutInput,
  type CanvasPutFrameInput,
  type CanvasResourceUpdateInput,
  type CanvasRestoreFramesInput,
  type CanvasRestoreTurnInput,
  type CanvasStreamEvent,
  type CanvasWork,
  type CanvasWorkCover,
  type CanvasWorkSummary,
  type DesignFrame,
  type ThreadId,
} from "@synara/contracts";
import { serializeDesignLayers } from "@synara/shared/designCanvasLayers";
import {
  canvasPageList,
  canvasPageListParts,
  moveCanvasPageListItem,
  type CanvasPageListItem,
} from "@synara/shared/designCanvasPages";
import { createFileStringExclusively, writeFileStringAtomically } from "./atomicWrite";
import { makeCanvasTurnHistory, type CanvasTurnCaller } from "./canvasTurnHistory";
import { editDesignFrame, putDesignFrame, validateDesignFrame } from "./designCanvasFrames";
import type { DesignLayerEditOptions } from "./designCanvasLayers";
import { readAuthorizedFileBytes } from "./workspace/readAuthorizedFileBytes";

/** The document plus its asset bytes. */
const MAX_WORK_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 48 * 1024;
const MAX_ASSETS = 192;
/** Larger layer deltas travel as plain invalidations; subscribers refetch the one work. */
const MAX_DELTA_BYTES = 64 * 1024;
const ASSET_FILE = /^[a-f0-9]{64}$/;
/** How version 2 stored a work: every asset inline as base64. Read, never written. */
const CanvasWorkV2 = Schema.Struct({
  ...CanvasWorkSchema.fields,
  version: Schema.Literal(2),
  assets: Schema.optional(Schema.Array(CanvasAssetUpload).check(Schema.isMaxLength(MAX_ASSETS))),
});
/** Asset bytes by SHA-256 that still have to reach their content-addressed file. */
type AssetBytes = ReadonlyMap<string, Buffer>;
type Loaded = { resource: CanvasResource; assets: AssetBytes };
type ChangeDetail = Pick<
  CanvasChangedEvent,
  "pageId" | "frameId" | "revision" | "mutationId" | "delta"
>;
type Entry = { summary: CanvasWorkSummary | CanvasFolder; chats: CanvasWork["chats"] };
type Index = { entries: Map<string, Entry>; unavailableIds: string[] };
type Listener = (event: CanvasStreamEvent) => void;
type AgentActivityEvent = Extract<CanvasStreamEvent, { type: "activity" }>;
/** Per thread, the pages it has live activity on, so its turn's end can clear them. */
type TrackedActivity = Map<
  string,
  Map<string, { workId: string; pageId: string; expiresAt: number }>
>;
const MAX_ACTIVITY_THREADS = 256;
const indexes = new Map<string, Promise<Index>>();
const changeListeners = new Map<string, Set<Listener>>();
const agentActivity = new Map<string, TrackedActivity>();
const writes = new Map<string, Promise<unknown>>();
// Clients order a work's events by `updatedAt`, so it never goes backwards (see loadIndex).
let lastTimestamp = 0;
const now = () => new Date((lastTimestamp = Math.max(Date.now(), lastTimestamp + 1))).toISOString();
const emptyPage = (id: string, title: string): CanvasPage => ({
  id,
  title,
  viewport: CANVAS_DEFAULT_VIEWPORT,
  frames: [],
  comments: [],
});
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Version 2 kept bytes inline; the next commit moves them to files and writes version 3. */
function upgradeWork(
  legacy: typeof CanvasWorkV2.Type,
  hashAssets: boolean,
): { work: CanvasWork; assets: Map<string, Buffer> } {
  const { assets: inline = [], ...rest } = legacy;
  const assets = new Map<string, Buffer>();
  const metadata: CanvasAsset[] = [];
  // The dashboard index needs no asset metadata; hashing waits until the work is opened.
  if (hashAssets)
    for (const { data, ...asset } of inline) {
      const bytes = Buffer.from(data, "base64");
      const hash = sha256(bytes);
      assets.set(hash, bytes);
      metadata.push({ ...asset, sizeBytes: bytes.length, sha256: hash });
    }
  return {
    work: { ...rest, version: 3, ...(metadata.length > 0 ? { assets: metadata } : {}) },
    assets,
  };
}

/** A committed change to one work, ordered by its `updatedAt` before and after. */
const workEvent = (
  committed: CanvasResource,
  previousUpdatedAt?: string,
  detail: ChangeDetail = {},
): CanvasStreamEvent => ({
  type: "changed",
  scope: "work",
  workId: committed.id,
  updatedAt: committed.updatedAt,
  ...(previousUpdatedAt ? { previousUpdatedAt } : {}),
  ...detail,
});

/** The work's cover frame while it still exists, else its first frame. */
function previewFrame(work: CanvasWork): DesignFrame | undefined {
  const cover = work.cover;
  const chosen = cover
    ? work.pages
        .find((page) => page.id === cover.pageId)
        ?.frames.find((frame) => frame.id === cover.frameId)
    : undefined;
  return chosen ?? work.pages.flatMap((page) => page.frames).at(0);
}

/**
 * The assets a preview's markup refers to: images by their `synara-asset:` id, fonts by the
 * family they provide. Only these load in the library, not every asset of every work.
 */
function previewAssetsOf(assets: readonly CanvasAsset[] | undefined, markup: string) {
  const lower = markup.toLowerCase();
  return (assets ?? []).filter((asset) =>
    asset.mimeType === "font/woff2"
      ? asset.font !== undefined && lower.includes(asset.font.family.toLowerCase())
      : markup.includes(`synara-asset:${asset.id}`),
  );
}

function summarize(resource: CanvasResource): Entry {
  if (resource.kind === "folder") return { summary: resource, chats: [] };
  const frame = previewFrame(resource);
  const html = frame ? serializeDesignLayers(frame.layers, false) : "";
  const preview =
    frame && Buffer.byteLength(html) + Buffer.byteLength(frame.style ?? "") <= MAX_PREVIEW_BYTES
      ? { layers: frame.layers, style: frame.style ?? "", width: frame.width, height: frame.height }
      : null;
  const previewAssets = preview ? previewAssetsOf(resource.assets, html + preview.style) : [];
  const { id, title, folderId, createdAt, updatedAt, archivedAt, projectId } = resource;
  return {
    summary: {
      kind: "work",
      id,
      title,
      folderId,
      createdAt,
      updatedAt,
      archivedAt,
      projectId,
      pageCount: resource.pages.length,
      frameCount: resource.pages.reduce((total, page) => total + page.frames.length, 0),
      preview,
      ...(previewAssets.length > 0 ? { previewAssets } : {}),
    },
    chats: resource.chats,
  };
}

function replaceFrame(page: CanvasPage, frame: DesignFrame): CanvasPage {
  return {
    ...page,
    frames: page.frames.some((item) => item.id === frame.id)
      ? page.frames.map((item) => (item.id === frame.id ? frame : item))
      : [...page.frames, frame],
  };
}

/** One atomic document per work. The bounded dashboard index is derived, never authoritative. */

/** A frame flag that is off is left out of the document (additive for older readers). */
function frameFlag(frame: DesignFrame, name: "hidden" | "locked", value: boolean | undefined) {
  if (value === undefined) return frame;
  const { [name]: _previous, ...rest } = frame;
  return value ? { ...rest, [name]: true } : rest;
}

export function makeCanvasLibraryStore(stateDir: string) {
  const directory = path.join(stateDir, "design-canvases", "library");
  // Content-addressed and shared by every work, so duplicates and repeated fonts cost nothing.
  const assetDirectory = path.join(stateDir, "design-canvases", "assets");
  const history = makeCanvasTurnHistory(stateDir);
  const fileKey = (id: string) =>
    createHash("sha256").update(Schema.decodeUnknownSync(CanvasId)(id)).digest("hex");
  const fileFor = (id: string) => path.join(directory, `${fileKey(id)}.json`);
  const publish = (event: CanvasStreamEvent) => {
    for (const listener of changeListeners.get(directory) ?? []) {
      try {
        listener(event);
      } catch {
        /* Observers cannot roll back a committed document. */
      }
    }
  };
  /** Reads one asset's bytes from its file, only when they still match their name. */
  const readAssetFile = async (hash: string): Promise<Buffer | null> => {
    if (!ASSET_FILE.test(hash)) return null;
    const root = await realpath(assetDirectory).catch(() => null);
    if (!root) return null;
    const bytes = await readAuthorizedFileBytes(
      path.join(root, hash),
      root,
      [root],
      CANVAS_MAX_ASSET_BYTES,
    );
    return bytes && sha256(bytes) === hash ? bytes : null;
  };
  const storeAssetFile = async (hash: string, bytes: Buffer) => {
    if (!ASSET_FILE.test(hash) || sha256(bytes) !== hash) throw new Error("Canvas asset mismatch.");
    const filePath = path.join(assetDirectory, hash);
    if (await Effect.runPromise(createFileStringExclusively({ filePath, contents: bytes }))) return;
    // Another work already stored these bytes; repair the file only if it was damaged.
    if (await readAssetFile(hash)) return;
    await Effect.runPromise(writeFileStringAtomically({ filePath, contents: bytes }));
  };
  const readResource = async (file: string, hashAssets = true): Promise<Loaded> => {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_WORK_BYTES)
      throw new Error("Canvas exceeds its 8 MiB storage limit.");
    const json: unknown = JSON.parse(await readFile(file, "utf8"));
    const legacy =
      typeof json === "object" &&
      json !== null &&
      (json as { kind?: unknown }).kind === "work" &&
      (json as { version?: unknown }).version === 2;
    const upgraded = legacy
      ? upgradeWork(Schema.decodeUnknownSync(CanvasWorkV2)(json), hashAssets)
      : null;
    const resource = upgraded?.work ?? Schema.decodeUnknownSync(CanvasResource)(json);
    const assets: AssetBytes = upgraded?.assets ?? new Map();
    if (resource.kind === "folder") return { resource, assets };
    const listIds = [...resource.pages, ...(resource.dividers ?? [])].map((item) => item.id);
    if (new Set(listIds).size !== listIds.length) throw new Error("Duplicate canvas page ID.");
    const metadata = resource.assets ?? [];
    if (new Set(metadata.map((asset) => asset.id)).size !== metadata.length)
      throw new Error("Duplicate canvas asset ID.");
    for (const page of resource.pages) {
      if (
        new Set(page.frames.map((frame) => frame.id)).size !== page.frames.length ||
        new Set(page.comments.map((thread) => thread.id)).size !== page.comments.length
      )
        throw new Error("Duplicate canvas object ID.");
      page.frames.forEach(validateDesignFrame);
    }
    return { resource, assets };
  };
  const loadIndex = () => {
    let pending = indexes.get(directory);
    if (!pending) {
      pending = (async () => {
        const index: Index = { entries: new Map(), unavailableIds: [] };
        const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const name of names) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          try {
            const { resource } = await readResource(path.join(directory, name), false);
            if (`${fileKey(resource.id)}.json` !== name)
              throw new Error("Canvas identity mismatch.");
            index.entries.set(resource.id, summarize(resource));
            // A restarted server with a clock behind its last commit still orders events.
            lastTimestamp = Math.max(lastTimestamp, Date.parse(resource.updatedAt) || 0);
          } catch {
            index.unavailableIds.push(name.slice(0, -5));
          }
        }
        return index;
      })();
      indexes.set(directory, pending);
      void pending.catch(() => {
        if (indexes.get(directory) === pending) indexes.delete(directory);
      });
    }
    return pending;
  };
  const getResource = async (id: string): Promise<Loaded> => {
    const loaded = await readResource(fileFor(id));
    if (loaded.resource.id !== id) throw new Error("Canvas identity mismatch.");
    return loaded;
  };
  const isArchived = (id: string, index: Index) => {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) throw new Error("Canvas folder cycle.");
      seen.add(current);
      const resource: Entry["summary"] | undefined = index.entries.get(current)?.summary;
      if (!resource) return false;
      if (resource.archivedAt) return true;
      current = resource.folderId;
    }
    return false;
  };
  const load = async (workId: string): Promise<{ work: CanvasWork; assets: AssetBytes }> => {
    Schema.decodeUnknownSync(CanvasId)(workId);
    const { resource, assets } = await getResource(workId);
    if (resource.kind !== "work") throw new Error("This resource is a folder, not a canvas.");
    return { work: { ...resource, readOnly: isArchived(workId, await loadIndex()) }, assets };
  };
  const get = async (workId: string): Promise<CanvasWork> => (await load(workId)).work;
  const checkFolder = (folderId: string | null, index: Index, movingId?: string) => {
    const seen = new Set(movingId ? [movingId] : []);
    let current = folderId;
    while (current) {
      if (seen.has(current)) throw new Error("A folder cannot be moved inside itself.");
      seen.add(current);
      const folder = index.entries.get(current)?.summary;
      if (!folder || folder.kind !== "folder" || folder.archivedAt)
        throw new Error("Destination folder is unavailable.");
      current = folder.folderId;
    }
  };
  /**
   * Asset bytes reach their files before the document that names them, so a committed work
   * never points at a missing file. Unchanged assets are never rewritten.
   */
  const commit = async (
    resource: CanvasResource,
    options: {
      authorize?: (() => Promise<void>) | undefined;
      assets?: AssetBytes;
      event: (committed: CanvasResource) => CanvasStreamEvent;
    },
  ) => {
    const { authorize } = options;
    const { readOnly: _readOnly, ...persisted } =
      resource.kind === "work" ? resource : { ...resource, readOnly: undefined };
    const decoded = Schema.decodeUnknownSync(CanvasResource)(persisted);
    const source = JSON.stringify(decoded);
    const assets = decoded.kind === "work" ? (decoded.assets ?? []) : [];
    if (
      Buffer.byteLength(source) + assets.reduce((total, asset) => total + asset.sizeBytes, 0) >
      MAX_WORK_BYTES
    )
      throw new Error("Canvas exceeds its 8 MiB storage limit.");
    const index = await loadIndex();
    for (const asset of assets) {
      const bytes = options.assets?.get(asset.sha256);
      if (bytes) await storeAssetFile(asset.sha256, bytes);
    }
    try {
      await Effect.runPromise(
        writeFileStringAtomically({
          filePath: fileFor(decoded.id),
          contents: source,
          ...(authorize ? { beforeCommit: authorize } : {}),
        }),
      );
    } catch (error) {
      // Rename may have published before a directory fsync failure. Reconcile the authoritative
      // file before the next queued operation; never overwrite it based on a stale catalog.
      try {
        index.entries.set(
          decoded.id,
          summarize((await readResource(fileFor(decoded.id), false)).resource),
        );
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT")
          index.unavailableIds.push(fileKey(decoded.id));
      }
      throw error;
    }
    index.entries.set(decoded.id, summarize(decoded));
    publish(options.event(decoded));
    return decoded;
  };
  const enqueue = async <A>(run: () => Promise<A>): Promise<A> => {
    const pending = (writes.get(directory) ?? Promise.resolve()).catch(() => {}).then(run);
    writes.set(directory, pending);
    try {
      return await pending;
    } finally {
      if (writes.get(directory) === pending) writes.delete(directory);
    }
  };
  /** Agent writes with a turn also record that turn's restore point for each touched page. */
  const mutate = <A>(
    workId: string,
    change: (work: CanvasWork) => {
      work: CanvasWork;
      result: A;
      /** Records the agent turn's restore point for this page. */
      pageId?: string;
      /** What subscribers learn beyond the work: its page, frame, revision and delta. */
      detail?: ChangeDetail;
      /** Bytes of assets this change adds, by SHA-256. */
      assets?: AssetBytes;
    },
    authorize?: () => Promise<void>,
    caller?: CanvasTurnCaller,
  ) =>
    enqueue(async () => {
      const index = await loadIndex();
      if (isArchived(workId, index))
        throw new Error("Restore this canvas from Archive before editing.");
      const { work: current, assets } = await load(workId);
      const changed = change(current);
      const work = (await commit(
        { ...changed.work, updatedAt: now() },
        {
          authorize,
          assets: changed.assets ? new Map([...assets, ...changed.assets]) : assets,
          event: (committed) =>
            workEvent(committed, current.updatedAt, {
              ...(changed.pageId ? { pageId: changed.pageId } : {}),
              ...changed.detail,
            }),
        },
      )) as CanvasWork;
      if (caller && changed.pageId)
        await history.record(caller, current, work, changed.pageId).catch(() => {
          /* A missing restore point must not undo a committed agent edit. */
        });
      return { work, result: changed.result };
    });
  const requirePage = (work: CanvasWork, pageId: string) => {
    const page = work.pages.find((item) => item.id === pageId);
    if (!page) throw new Error("Canvas page not found.");
    return page;
  };
  const withPage = (work: CanvasWork, pageId: string, change: (page: CanvasPage) => CanvasPage) => {
    requirePage(work, pageId);
    return { ...work, pages: work.pages.map((page) => (page.id === pageId ? change(page) : page)) };
  };
  const bind = (work: CanvasWork, threadId: ThreadId, pageId: string): CanvasWork => {
    requirePage(work, pageId);
    return {
      ...work,
      chats: [
        ...work.chats.filter((chat) => chat.threadId !== threadId),
        { threadId, pageId, usedAt: now() },
      ].slice(-200),
    };
  };
  const freshResource = async (id: string) => {
    const index = await loadIndex();
    if (index.unavailableIds.includes(fileKey(id)))
      throw new Error("An unreadable resource already owns this ID.");
    if (index.entries.has(id))
      throw new Error("Resource ID is already used; read it before retrying.");
    return index;
  };
  const requireFrame = (page: CanvasPage, frameId: string) => {
    const frame = page.frames.find((item) => item.id === frameId);
    if (!frame) throw new Error("Canvas view not found.");
    return frame;
  };
  /** Sets or clears a work's cover frame: a frame of that work, which must be editable. */
  const withCover = (
    resource: CanvasResource,
    cover: CanvasWorkCover | null,
    index: Index,
  ): CanvasResource => {
    if (resource.kind !== "work") throw new Error("Only a canvas has a cover.");
    if (isArchived(resource.id, index))
      throw new Error("Restore this canvas from Archive before editing.");
    const { cover: _previous, ...rest } = resource;
    if (cover === null) return rest;
    requireFrame(requirePage(resource, cover.pageId), cover.frameId);
    return { ...rest, cover };
  };

  return {
    subscribe(listener: Listener) {
      const listeners = changeListeners.get(directory) ?? new Set<Listener>();
      changeListeners.set(directory, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) changeListeners.delete(directory);
      };
    },
    /** Ephemeral events (agent badges, render requests); never persisted. */
    publish,
    /** Publishes what an agent is reading or writing and remembers it until its turn ends. */
    recordAgentActivity(event: Omit<AgentActivityEvent, "type" | "ended">) {
      publish({ type: "activity", ...event });
      let threads = agentActivity.get(directory);
      if (!threads) agentActivity.set(directory, (threads = new Map()));
      const pages = threads.get(event.threadId) ?? new Map();
      // Most recently active last, so the bound drops the threads idle the longest.
      threads.delete(event.threadId);
      threads.set(event.threadId, pages);
      pages.set(`${event.workId}/${event.pageId}`, {
        workId: event.workId,
        pageId: event.pageId,
        expiresAt: Date.parse(event.expiresAt),
      });
      while (threads.size > MAX_ACTIVITY_THREADS) threads.delete(threads.keys().next().value!);
    },
    /**
     * The thread's turn ended: one `ended` event per page it still had live activity on, so
     * clients drop it, without the agent having to say it is done.
     * Returns how many pages were cleared.
     */
    endAgentActivity(threadId: ThreadId): number {
      const threads = agentActivity.get(directory);
      const pages = threads?.get(threadId);
      if (!threads || !pages) return 0;
      threads.delete(threadId);
      if (threads.size === 0) agentActivity.delete(directory);
      const now = Date.now();
      let cleared = 0;
      for (const { workId, pageId, expiresAt } of pages.values()) {
        if (expiresAt <= now) continue;
        publish({
          type: "activity",
          workId,
          pageId,
          frameIds: [],
          threadId,
          expiresAt: new Date(now).toISOString(),
          ended: true,
        });
        cleared++;
      }
      return cleared;
    },
    get,
    async list(input: CanvasListInput = {}): Promise<CanvasListResult> {
      const index = await loadIndex();
      const resources = [...index.entries.values()]
        .map((entry) => entry.summary)
        .filter((resource) => isArchived(resource.id, index) === (input.archived ?? false));
      const usedAt = (id: string) =>
        index.entries.get(id)?.chats.find((chat) => chat.threadId === input.threadId)?.usedAt ?? "";
      const matches = resources
        .filter(
          (resource): resource is CanvasWorkSummary =>
            resource.kind === "work" &&
            (input.projectId === undefined || resource.projectId === input.projectId) &&
            (input.threadId === undefined || usedAt(resource.id) !== "") &&
            (input.folderId === undefined || resource.folderId === input.folderId) &&
            (!input.search ||
              resource.title.toLocaleLowerCase().includes(input.search.toLocaleLowerCase())),
        )
        .toSorted((a, b) =>
          input.threadId
            ? usedAt(b.id).localeCompare(usedAt(a.id))
            : b.updatedAt.localeCompare(a.updatedAt),
        );
      const offset = input.offset ?? 0;
      return {
        works: matches.slice(offset, offset + (input.limit ?? 50)),
        total: matches.length,
        folders: resources.filter(
          (resource): resource is CanvasFolder => resource.kind === "folder",
        ),
        unavailableIds: index.unavailableIds,
      };
    },
    create: (input: CanvasCreateInput, authorize?: () => Promise<void>, caller?: ThreadId) =>
      enqueue(async () => {
        const index = await freshResource(input.id);
        checkFolder(input.folderId ?? null, index);
        const timestamp = now();
        const work: CanvasWork = {
          version: 3,
          kind: "work",
          id: input.id,
          title: input.title,
          folderId: input.folderId ?? null,
          projectId: input.projectId ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
          pages: [emptyPage("page-main", "Page 1")],
          chats: [],
        };
        return (await commit(caller ? bind(work, caller, "page-main") : work, {
          authorize,
          event: (committed) => workEvent(committed),
        })) as CanvasWork;
      }),
    createFolder: (input: CanvasCreateInput, authorize?: () => Promise<void>) =>
      enqueue(async () => {
        const index = await loadIndex();
        if (index.unavailableIds.includes(fileKey(input.id)))
          throw new Error("An unreadable resource already owns this ID.");
        const existing = index.entries.get(input.id)?.summary;
        if (existing) {
          if (
            existing.kind !== "folder" ||
            existing.title !== input.title ||
            existing.folderId !== (input.folderId ?? null)
          )
            throw new Error("Resource ID is already used.");
          return existing;
        }
        checkFolder(input.folderId ?? null, index);
        const timestamp = now();
        return (await commit(
          {
            version: 2,
            kind: "folder",
            id: input.id,
            title: input.title,
            folderId: input.folderId ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
            archivedAt: null,
          },
          // A new folder holds nothing yet: only the list changes.
          { authorize, event: () => ({ type: "changed", scope: "library" }) },
        )) as CanvasFolder;
      }),
    update: (input: CanvasResourceUpdateInput, authorize?: () => Promise<void>) =>
      enqueue(async () => {
        const { resource, assets } = await getResource(input.id);
        if (input.folderId !== undefined) checkFolder(input.folderId, await loadIndex(), input.id);
        return commit(
          {
            ...(input.cover !== undefined
              ? withCover(resource, input.cover, await loadIndex())
              : resource),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
            ...(input.archived !== undefined ? { archivedAt: input.archived ? now() : null } : {}),
            ...(resource.kind === "work" && input.projectId !== undefined
              ? { projectId: input.projectId }
              : {}),
            updatedAt: now(),
          },
          {
            authorize,
            assets,
            // Archiving or moving a folder changes which works are read-only: refresh all.
            event: (committed) =>
              committed.kind === "work"
                ? workEvent(committed, resource.updatedAt)
                : { type: "changed" },
          },
        );
      }),
    duplicate: (input: CanvasDuplicateInput, authorize?: () => Promise<void>) =>
      enqueue(async () => {
        const index = await freshResource(input.id);
        const { work: original, assets } = await load(input.workId);
        const timestamp = now();
        // The copy's pages get new IDs; its dividers and cover follow them.
        const pageIds = new Map(original.pages.map((page) => [page.id, randomUUID()]));
        const { dividers, cover, ...rest } = original;
        const copiedCover = cover && pageIds.get(cover.pageId);
        const copy: CanvasWork = {
          ...rest,
          id: input.id,
          title: input.title,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          chats: [],
          pages: original.pages.map((page) => ({
            ...page,
            id: pageIds.get(page.id)!,
            comments: [],
            frames: page.frames.map(({ lastLayerEdit: _receipt, ...frame }) => ({
              ...frame,
              layers: structuredClone(frame.layers),
            })),
          })),
          ...(dividers?.length
            ? {
                dividers: dividers.map((divider) => ({
                  id: randomUUID(),
                  beforePageId:
                    divider.beforePageId === null
                      ? null
                      : (pageIds.get(divider.beforePageId) ?? null),
                })),
              }
            : {}),
          ...(cover && copiedCover ? { cover: { ...cover, pageId: copiedCover } } : {}),
        };
        const destination = isArchived(original.id, index) ? { ...copy, folderId: null } : copy;
        checkFolder(destination.folderId, index);
        return (await commit(destination, {
          authorize,
          assets,
          event: (committed) => workEvent(committed),
        })) as CanvasWork;
      }),
    changePages: async (input: CanvasPageChangeInput, authorize?: () => Promise<void>) =>
      (
        await mutate(
          input.workId,
          (work) => {
            const operation = input.operation;
            const list = canvasPageList(work);
            const item = list.find((entry) => entry.id === operation.id);
            const page = item?.kind === "page" ? item.page : undefined;
            const unchanged = { work, result: undefined };
            /** The work with its pages and dividers laid out as `items`. */
            const arranged = (items: CanvasPageListItem<CanvasPage>[]) => {
              const { pages, dividers } = canvasPageListParts(items);
              const { dividers: _previous, ...rest } = work;
              return {
                work: { ...rest, pages, ...(dividers.length > 0 ? { dividers } : {}) },
                result: undefined,
              };
            };
            if (operation.type === "create" || operation.type === "add_divider") {
              if (item) {
                // A retried create is a no-op; an ID already used by the other kind is not.
                if (item.kind === (operation.type === "create" ? "page" : "divider"))
                  return unchanged;
                throw new Error("This ID is already used in the page list.");
              }
              if (operation.type === "create") {
                if (work.pages.length >= CANVAS_MAX_PAGES)
                  throw new Error(`A canvas holds at most ${CANVAS_MAX_PAGES} pages.`);
                // New pages go last, below any trailing divider.
                return arranged([
                  ...list,
                  {
                    kind: "page",
                    id: operation.id,
                    page: emptyPage(operation.id, operation.title),
                  },
                ]);
              }
              if ((work.dividers?.length ?? 0) >= CANVAS_MAX_PAGE_DIVIDERS)
                throw new Error(`A canvas holds at most ${CANVAS_MAX_PAGE_DIVIDERS} dividers.`);
              return arranged(
                moveCanvasPageListItem(
                  [...list, { kind: "divider", id: operation.id }],
                  operation.id,
                  operation.beforeId,
                ),
              );
            }
            if (operation.type === "move")
              return arranged(moveCanvasPageListItem(list, operation.id, operation.beforeId));
            if (operation.type === "delete_divider") {
              if (!item) return unchanged;
              if (item.kind !== "divider") throw new Error("Canvas divider not found.");
              return arranged(list.filter((entry) => entry !== item));
            }
            if (!page) {
              if (operation.type === "delete" && !item) return unchanged;
              throw new Error("Canvas page not found.");
            }
            if (operation.type === "rename")
              return {
                work: withPage(work, page.id, (current) => ({
                  ...current,
                  title: operation.title,
                })),
                result: undefined,
              };
            if (operation.type === "set_icon")
              return {
                work: withPage(work, page.id, ({ icon: _previous, ...current }) =>
                  operation.icon === null ? current : { ...current, icon: operation.icon },
                ),
                result: undefined,
              };
            if (operation.type === "set_color")
              return {
                work: withPage(work, page.id, ({ color: _previous, ...current }) =>
                  operation.color === null ? current : { ...current, color: operation.color },
                ),
                result: undefined,
              };
            if (work.pages.length === 1) throw new Error("A canvas must keep at least one page.");
            const next = arranged(list.filter((entry) => entry !== item));
            const pages = next.work.pages;
            const { cover, ...rest } = next.work;
            return {
              work: {
                ...rest,
                // A cover on the deleted page goes with it.
                ...(cover && cover.pageId !== page.id ? { cover } : {}),
                chats: work.chats.map((chat) =>
                  chat.pageId === page.id ? { ...chat, pageId: pages[0]!.id } : chat,
                ),
              },
              result: undefined,
            };
          },
          authorize,
        )
      ).work,
    putAssets: async (
      workId: string,
      incoming: readonly CanvasAssetUpload[],
      authorize?: () => Promise<void>,
    ) =>
      (
        await mutate(
          workId,
          (work) => {
            const assets = [...(work.assets ?? [])];
            const added = new Map<string, Buffer>();
            for (const { data, ...upload } of incoming) {
              const bytes = Buffer.from(data, "base64");
              const hash = sha256(bytes);
              const previous = assets.find((item) => item.id === upload.id);
              if (previous && (previous.sha256 !== hash || previous.mimeType !== upload.mimeType))
                throw new Error("Asset ID already exists; use a new ID for different bytes.");
              if (previous) continue;
              assets.push({ ...upload, sizeBytes: bytes.length, sha256: hash });
              added.set(hash, bytes);
            }
            if (assets.length > MAX_ASSETS) throw new Error("A canvas holds at most 192 assets.");
            return { work: { ...work, assets }, result: undefined, assets: added };
          },
          authorize,
        )
      ).work,
    /** One asset's bytes, only for an asset the work names. */
    async getAsset(workId: string, assetId: string): Promise<CanvasAssetData> {
      const { work, assets } = await load(workId);
      const asset = work.assets?.find((item) => item.id === assetId);
      if (!asset) throw new Error("Canvas asset not found.");
      const bytes = assets.get(asset.sha256) ?? (await readAssetFile(asset.sha256));
      if (!bytes) throw new Error("Canvas asset is unavailable.");
      return {
        assetId: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        data: bytes.toString("base64"),
      };
    },
    bindChat: async (input: CanvasBindChatInput, authorize?: () => Promise<void>) =>
      (
        await mutate(
          input.workId,
          (work) => ({ work: bind(work, input.threadId, input.pageId), result: undefined }),
          authorize,
        )
      ).work,
    async resolveChat(threadId: ThreadId) {
      const index = await loadIndex();
      const matches = [...index.entries.values()].flatMap((entry) =>
        entry.chats
          .filter((chat) => chat.threadId === threadId)
          .map((chat) => ({ workId: entry.summary.id, pageId: chat.pageId, usedAt: chat.usedAt })),
      );
      return matches.toSorted((a, b) => b.usedAt.localeCompare(a.usedAt))[0] ?? null;
    },
    layout: async (
      input: CanvasPageLayoutInput,
      authorize?: () => Promise<void>,
      caller?: CanvasTurnCaller,
    ) =>
      (
        await mutate(
          input.workId,
          (work) => ({
            work: withPage(work, input.pageId, (page) => {
              const patches = new Map((input.frames ?? []).map((patch) => [patch.id, patch]));
              for (const id of patches.keys()) requireFrame(page, id);
              for (const id of input.order ?? []) requireFrame(page, id);
              const ordered = input.order
                ? [
                    ...input.order.flatMap((id) => page.frames.filter((frame) => frame.id === id)),
                    ...page.frames.filter((frame) => !input.order!.includes(frame.id)),
                  ]
                : page.frames;
              const frames = ordered
                .filter((frame) => !patches.get(frame.id)?.remove)
                .map((frame) => {
                  const patch = patches.get(frame.id);
                  if (!patch) return frame;
                  const changedContent =
                    (patch.width !== undefined && patch.width !== frame.width) ||
                    (patch.height !== undefined && patch.height !== frame.height) ||
                    (patch.title !== undefined && patch.title !== frame.title);
                  return frameFlag(
                    frameFlag(
                      {
                        ...frame,
                        x: patch.x ?? frame.x,
                        y: patch.y ?? frame.y,
                        width: patch.width ?? frame.width,
                        height: patch.height ?? frame.height,
                        title: patch.title ?? frame.title,
                        revision: frame.revision + (changedContent ? 1 : 0),
                      },
                      "hidden",
                      patch.hidden,
                    ),
                    "locked",
                    patch.locked,
                  );
                });
              const removed = new Set(
                [...patches.values()].filter((patch) => patch.remove).map((patch) => patch.id),
              );
              const exportSettings: Record<string, readonly CanvasExportEntry[]> = {
                ...page.exportSettings,
              };
              for (const patch of input.exportSettings ?? []) {
                if (patch.entries?.length) exportSettings[patch.key] = patch.entries;
                else delete exportSettings[patch.key];
              }
              // Rows of removed frames and deleted layers go with them.
              for (const key of Object.keys(exportSettings)) {
                const [, frameId, layerId] = key.split(":");
                const frame = frames.find((item) => item.id === frameId);
                if (!frame || (layerId && !frame.layers.nodes.some((node) => node.id === layerId)))
                  delete exportSettings[key];
              }
              if (Object.keys(exportSettings).length > 500)
                throw new Error("A canvas page keeps export settings for at most 500 layers.");
              const { exportSettings: _previous, ...rest } = page;
              return {
                ...rest,
                viewport: input.viewport ?? page.viewport,
                frames,
                comments: page.comments.filter((thread) => !removed.has(thread.frameId)),
                ...(Object.keys(exportSettings).length > 0 ? { exportSettings } : {}),
              };
            }),
            result: undefined,
            pageId: input.pageId,
          }),
          authorize,
          caller,
        )
      ).work,
    putFrame: async (
      input: CanvasPutFrameInput,
      authorize?: () => Promise<void>,
      caller?: CanvasTurnCaller,
    ) => {
      const { work, result } = await mutate(
        input.workId,
        (current) => {
          const page = requirePage(current, input.pageId);
          const put = putDesignFrame(page.frames, input.frame);
          return {
            work: withPage(current, input.pageId, (item) => replaceFrame(item, put.frame)),
            result: put,
            pageId: input.pageId,
            detail: { frameId: put.frame.id, revision: put.frame.revision },
          };
        },
        authorize,
        caller,
      );
      return { work, frame: result.frame, createdNodeIds: [], dropped: result.dropped };
    },
    editLayers: async (
      input: CanvasEditLayersInput,
      authorize?: () => Promise<void>,
      caller?: CanvasTurnCaller,
      options?: DesignLayerEditOptions,
    ) => {
      const { work, result } = await mutate(
        input.workId,
        (current) => {
          const page = requirePage(current, input.pageId);
          const edited = editDesignFrame(
            requireFrame(page, input.edit.frameId),
            input.edit,
            options,
          );
          const delta =
            edited.applied &&
            edited.frame.lastLayerEdit &&
            Buffer.byteLength(JSON.stringify(edited.applied)) <= MAX_DELTA_BYTES
              ? {
                  operations: edited.applied,
                  ...(edited.frame.style ? { style: edited.frame.style } : {}),
                  lastLayerEdit: edited.frame.lastLayerEdit,
                }
              : undefined;
          return {
            work: withPage(current, input.pageId, (item) => replaceFrame(item, edited.frame)),
            result: edited,
            pageId: input.pageId,
            detail: {
              frameId: edited.frame.id,
              revision: edited.frame.revision,
              mutationId: input.edit.mutationId,
              ...(delta ? { delta } : {}),
            },
          };
        },
        authorize,
        caller,
      );
      return {
        work,
        frame: result.frame,
        createdNodeIds: result.createdNodeIds,
        dropped: result.dropped,
        duplicates: result.duplicates,
      };
    },
    /** Undo of frame deletion or creation: exact frames come back with fresh revisions. */
    restoreFrames: async (input: CanvasRestoreFramesInput, authorize?: () => Promise<void>) =>
      (
        await mutate(
          input.workId,
          (work) => ({
            work: withPage(work, input.pageId, (page) => {
              const removed = new Set(input.removeFrameIds);
              let frames = page.frames.filter((frame) => !removed.has(frame.id));
              for (const restored of input.frames) {
                const current = frames.find((frame) => frame.id === restored.id);
                const frame = validateDesignFrame({
                  ...restored,
                  revision: Math.max(restored.revision, current?.revision ?? 0) + 1,
                });
                frames = current
                  ? frames.map((item) => (item.id === frame.id ? frame : item))
                  : [...frames, frame];
              }
              if (frames.length > 48) throw new Error("A canvas page holds at most 48 views.");
              const comments = page.comments.filter((thread) => !removed.has(thread.frameId));
              const kept = new Set(frames.map((frame) => frame.id));
              const taken = new Set(comments.map((thread) => thread.id));
              for (const thread of input.comments ?? []) {
                if (!kept.has(thread.frameId) || taken.has(thread.id)) continue;
                if (comments.length >= CANVAS_MAX_COMMENT_THREADS) break;
                taken.add(thread.id);
                comments.push(thread);
              }
              return { ...page, frames, comments };
            }),
            result: undefined,
            detail: { pageId: input.pageId },
          }),
          authorize,
        )
      ).work,
    changeComments: async (
      input: CanvasCommentChangeInput,
      author: CanvasCommentAuthor,
      authorize?: () => Promise<void>,
    ) =>
      (
        await mutate(
          input.workId,
          (work) => ({
            work: withPage(work, input.pageId, (page) => {
              const operation = input.operation;
              const timestamp = now();
              const thread = page.comments.find((item) => item.id === operation.threadId);
              if (operation.type === "create") {
                if (thread) {
                  if (thread.messages[0]?.id === operation.messageId) return page;
                  throw new Error("Comment thread ID is already used.");
                }
                if (page.comments.length >= CANVAS_MAX_COMMENT_THREADS)
                  throw new Error(
                    "This page has reached its comment limit; resolve or delete some.",
                  );
                const frame = requireFrame(page, operation.frameId);
                if (
                  operation.layerId !== null &&
                  !frame.layers.nodes.some((node) => node.id === operation.layerId)
                )
                  throw new Error("Commented layer not found.");
                return {
                  ...page,
                  comments: [
                    ...page.comments,
                    {
                      id: operation.threadId,
                      frameId: operation.frameId,
                      layerId: operation.layerId,
                      x: operation.x,
                      y: operation.y,
                      status: "open",
                      createdAt: timestamp,
                      updatedAt: timestamp,
                      messages: [
                        {
                          id: operation.messageId,
                          author,
                          text: operation.text,
                          createdAt: timestamp,
                        },
                      ],
                    },
                  ],
                };
              }
              if (!thread) {
                if (operation.type === "delete") return page;
                throw new Error("Comment thread not found.");
              }
              const update = (patch: Partial<typeof thread>) => ({
                ...page,
                comments: page.comments.map((item) =>
                  item.id === thread.id ? { ...item, ...patch, updatedAt: timestamp } : item,
                ),
              });
              if (operation.type === "reply") {
                if (thread.messages.some((message) => message.id === operation.messageId))
                  return page;
                if (thread.messages.length >= CANVAS_MAX_COMMENT_MESSAGES)
                  throw new Error("This thread has reached its reply limit.");
                return update({
                  messages: [
                    ...thread.messages,
                    { id: operation.messageId, author, text: operation.text, createdAt: timestamp },
                  ],
                });
              }
              if (operation.type === "set_status") return update({ status: operation.status });
              if (operation.type === "move") return update({ x: operation.x, y: operation.y });
              if (operation.type === "mark_read") {
                // Reading changes nothing anyone else sees; the thread keeps its updatedAt.
                return {
                  ...page,
                  comments: page.comments.map((item) =>
                    item.id === thread.id ? { ...item, readAt: timestamp } : item,
                  ),
                };
              }
              if (operation.type === "edit_message" || operation.type === "delete_message") {
                const at = thread.messages.findIndex(
                  (message) => message.id === operation.messageId,
                );
                const message = thread.messages[at];
                if (!message) {
                  if (operation.type === "delete_message") return page;
                  throw new Error("Comment message not found.");
                }
                // Only a message's own author edits or deletes it.
                if (
                  message.author.kind !== author.kind ||
                  (message.author.kind === "agent" &&
                    author.kind === "agent" &&
                    message.author.threadId !== author.threadId)
                )
                  throw new Error("Only the author can change this message.");
                if (operation.type === "edit_message")
                  return update({
                    messages: thread.messages.map((item) =>
                      item.id === message.id
                        ? { ...item, text: operation.text, editedAt: timestamp }
                        : item,
                    ),
                  });
                if (at === 0) throw new Error("Delete the comment to remove its first message.");
                return update({
                  messages: thread.messages.filter((item) => item.id !== message.id),
                });
              }
              return { ...page, comments: page.comments.filter((item) => item.id !== thread.id) };
            }),
            result: undefined,
            detail: { pageId: input.pageId },
          }),
          authorize,
        )
      ).work,
    turnActivity: (threadId: ThreadId) => history.list(threadId),
    /** Put every frame the turn touched back to its state before that turn's first write. */
    restoreTurn: async (input: CanvasRestoreTurnInput) => {
      const entries = await history.entries(input.threadId, input.turnId, input.workId);
      const { work } = await mutate(input.workId, (current) => {
        let next = current;
        for (const entry of entries) {
          if (!next.pages.some((page) => page.id === entry.pageId)) continue;
          next = withPage(next, entry.pageId, (page) => {
            let frames = [...page.frames];
            for (const [id, before] of Object.entries(entry.before)) {
              const existing = frames.find((frame) => frame.id === id);
              if (before === null) {
                frames = frames.filter((frame) => frame.id !== id);
                continue;
              }
              const restored = {
                ...before,
                revision: Math.max(before.revision, existing?.revision ?? 0) + 1,
              };
              frames = existing
                ? frames.map((frame) => (frame.id === id ? restored : frame))
                : [...frames, restored];
            }
            const kept = new Set(frames.map((frame) => frame.id));
            return {
              ...page,
              frames,
              comments: page.comments.filter((thread) => kept.has(thread.frameId)),
            };
          });
        }
        return { work: next, result: undefined };
      });
      // History files share the library queue so agent writes never interleave with this one.
      await enqueue(() => history.markRestored(input.threadId, input.turnId, input.workId));
      // The work is unchanged since its commit event; this one refreshes the turn cards.
      publish(workEvent(work));
      return work;
    },
  };
}
