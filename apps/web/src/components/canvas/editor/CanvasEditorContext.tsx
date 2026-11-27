import type {
  CanvasPage,
  CanvasWork,
  DesignFrame,
  DesignLayerEdit,
  DesignViewport,
  ThreadId,
} from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "~/i18n";
import { sanitizeDesignStyle, type DesignLayerElement } from "~/lib/designCanvas";
import { randomUUID } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { toastManager } from "../../ui/toast";
import { useCanvasAssetUrls, useCanvasFonts } from "../canvasAssets";
import { selectionKey, useCanvasEditorStore, type CanvasSelectionItem } from "../canvasStores";
import { canvasWorkQueryKey, runCanvasWrite } from "../canvasWorkCache";
import {
  boundCamera,
  canvasCameraKey,
  createLiveCamera,
  openCanvasCamera,
  saveCanvasCamera,
  type CanvasCamera,
  type CanvasLiveCamera,
} from "./canvasCamera";
import { makeCanvasCommands, type CanvasCommands } from "./canvasCommands";
import {
  canvasHistoryFor,
  canvasHistoryTargets,
  CanvasHistoryRecorder,
  deletedLayerRows,
  holdCanvasHistory,
  invertEdit,
  invertExportSettings,
  invertLayout,
  invertRestore,
  replayableEdit,
  replayCanvasHistory,
  type CanvasChange,
} from "./canvasHistory";
import { indexLayers, type LayerIndex } from "./canvasSelection";
import { runCanvasJob, showHiddenCanvasComments } from "./canvasToasts";

export type FrameDom = {
  host: HTMLElement;
  shadow: ShadowRoot;
  root: HTMLElement;
  /** A layer's element, from the frame renderer's map rather than a DOM query. */
  layer: (layerId: string) => DesignLayerElement | null;
  /** Rewrites a layer (the frame root for null) from the model, dropping a live preview. */
  restore: (layerId: string | null) => void;
};
export type StylePatch = Readonly<Record<string, string | null>>;

export type CanvasEditorApi = {
  work: CanvasWork;
  page: CanvasPage;
  readOnly: boolean;
  /** The chat this canvas is shown beside, if any (comments are sent there). */
  threadId: ThreadId | null;
  selection: readonly CanvasSelectionItem[];
  /**
   * Selects, as an undo step. `record: false` leaves history alone (a gesture's
   * intermediate state); `from` records the change from that selection instead of the current.
   */
  select: (
    items: readonly CanvasSelectionItem[],
    options?: { record?: boolean; from?: readonly CanvasSelectionItem[] },
  ) => void;
  frame: (frameId: string) => DesignFrame | undefined;
  layers: (frameId: string) => LayerIndex | undefined;
  /** Live element of a selection item: the frame root for frames, an `SVGElement` for an SVG. */
  elementFor: {
    (item: Extract<CanvasSelectionItem, { kind: "frame" }>): HTMLElement | null;
    (item: CanvasSelectionItem): DesignLayerElement | null;
  };
  registerFrame: (frameId: string, dom: FrameDom | null) => void;
  /** Increments whenever rendered frames change; re-measure DOM when it does. */
  domVersion: number;
  bumpDom: () => void;
  fonts: ReadonlyMap<string, string>;
  /**
   * Applies a style patch to the live DOM only (scrubbing, color dragging). `quiet` previews
   * (canvas gestures) do not bump `domVersion`, so nothing re-renders while the pointer moves.
   */
  previewStyles: (
    items: readonly CanvasSelectionItem[],
    patch: StylePatch,
    options?: { quiet?: boolean },
  ) => void;
  /** Drops live previews on these items: they show their saved styles again. */
  discardPreview: (items: readonly CanvasSelectionItem[]) => void;
  /** Saves a style patch as one undo step. Frames receive frame styles. False if refused. */
  commitStyles: (items: readonly CanvasSelectionItem[], patch: StylePatch) => Promise<boolean>;
  run: (change: CanvasChange, options?: { record?: boolean }) => Promise<CanvasChangeResult | null>;
  /** Groups every `run` inside `task` into one undo step. */
  batch: <A>(task: () => Promise<A>) => Promise<A>;
  /** Drops the steps the open `batch` collected (an action that came to nothing). */
  discardBatch: () => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** The shared editor commands (keyboard, menus, layers panel, tools). */
  commands: CanvasCommands;
  /** This client's saved camera on the page; it is never written to the shared work. */
  viewport: DesignViewport;
  /**
   * Moves the camera and remembers it for this page. `automatic` placements (an empty page
   * centred on first visit) are not remembered, so the first frames still fit the camera.
   */
  setViewport: (viewport: DesignViewport, options?: { automatic?: boolean }) => void;
  /** The camera as shown, previews included; pans and wheel zooms move it without a render. */
  camera: CanvasLiveCamera;
  /** False until the camera was moved or placed on this page in this client. */
  cameraPlaced: boolean;
  editingText: Extract<CanvasSelectionItem, { kind: "layer" }> | null;
  setEditingText: (item: Extract<CanvasSelectionItem, { kind: "layer" }> | null) => void;
  /**
   * Opens a thread by ID (on its page, switching to it; comments hidden with ⇧C show again), or
   * closes the open one.
   */
  openComment: (target: { threadId: string; pageId?: string } | null) => void;
  activeCommentId: string | null;
  onAskAgent: ((prompt: string) => void) | null;
  /** Shows another page of this work (PageUp / PageDown); null where the host cannot. */
  selectPage: ((pageId: string) => void) | null;
  /** Opens the canvas library (⌘⇧D); null where the host cannot. */
  openLibrary: (() => void) | null;
  /**
   * Gives the keyboard back to the canvas (a rename ended with Enter or Escape), so single-key
   * shortcuts work again.
   */
  focusCanvas: () => void;
  /** The canvas element `focusCanvas` focuses; CanvasViewport sets it. */
  attachViewport: (element: HTMLElement | null) => void;
};

export type CanvasChangeResult = { work: CanvasWork; createdNodeIds: readonly string[] };

const CanvasEditorContext = createContext<CanvasEditorApi | null>(null);

export function useCanvasEditor(): CanvasEditorApi {
  const value = useContext(CanvasEditorContext);
  if (!value) throw new Error("useCanvasEditor must be used inside CanvasEditorProvider.");
  return value;
}

const mutationId = () => `m_${randomUUID().replaceAll("-", "")}`;

export function CanvasEditorProvider({
  work,
  pageId,
  readOnly,
  threadId = null,
  onAskAgent = null,
  onSelectPage = null,
  onOpenLibrary = null,
  children,
}: {
  work: CanvasWork;
  pageId: string;
  readOnly: boolean;
  threadId?: ThreadId | null;
  onAskAgent?: ((prompt: string) => void) | null;
  onSelectPage?: ((pageId: string) => void) | null;
  onOpenLibrary?: (() => void) | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const page = work.pages.find((item) => item.id === pageId) ?? work.pages[0]!;
  const workRef = useRef(work);
  workRef.current = work;
  const frames = useRef(new Map<string, FrameDom>());
  const [domVersion, setDomVersion] = useState(0);
  const bumpDom = useCallback(() => setDomVersion((value) => value + 1), []);
  // Cameras by page for this provider; a page not moved yet opens where openCanvasCamera says.
  const cameraKey = canvasCameraKey(work.id, page.id);
  const [cameras, setCameras] = useState<Readonly<Record<string, CanvasCamera>>>({});
  const camera = useMemo(
    () => cameras[cameraKey] ?? openCanvasCamera(work.id, { id: page.id, viewport: page.viewport }),
    [cameraKey, cameras, page.id, page.viewport, work.id],
  );
  /** Saves a camera under the page it belongs to, so a page switch never mixes them up. */
  const saveCamera = useCallback((key: string, viewport: DesignViewport, placed: boolean) => {
    setCameras((current) => ({ ...current, [key]: { key, viewport, placed } }));
    if (placed) saveCanvasCamera(key, viewport);
  }, []);
  const setViewport = useCallback<CanvasEditorApi["setViewport"]>(
    (next, options) => saveCamera(cameraKey, boundCamera(next), !options?.automatic),
    [cameraKey, saveCamera],
  );
  const [liveCamera] = useState(() =>
    createLiveCamera(cameraKey, camera.viewport, (key, viewport) =>
      saveCamera(key, viewport, true),
    ),
  );
  const { x: savedX, y: savedY, zoom: savedZoom } = camera.viewport;
  useLayoutEffect(
    () => liveCamera.sync(cameraKey, { x: savedX, y: savedY, zoom: savedZoom }),
    [cameraKey, liveCamera, savedX, savedY, savedZoom],
  );
  // A camera previewed when the editor closes is still this page's.
  useLayoutEffect(() => () => liveCamera.commit(), [liveCamera]);

  /** The editor as last rendered, for callbacks that run after an await (commands, undo). */
  const latestEditor = useRef<CanvasEditorApi | null>(null);
  const [editingText, setEditingText] = useState<CanvasEditorApi["editingText"]>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const history = canvasHistoryFor(work.id);
  useEffect(() => holdCanvasHistory(work.id), [work.id]);
  // This editor's undo groups; another editor on the same work has its own.
  const recorder = useMemo(() => new CanvasHistoryRecorder(history), [history]);
  const storedSelection = useCanvasEditorStore((state) => state.selection[work.id]);
  const setStoredSelection = useCanvasEditorStore((state) => state.setSelection);

  const indexes = useMemo(
    () => new Map(page.frames.map((frame) => [frame.id, indexLayers(frame.layers)])),
    [page.frames],
  );
  const frameById = useMemo(
    () => new Map(page.frames.map((frame) => [frame.id, frame])),
    [page.frames],
  );
  // Agents may delete what the user selected; drop what no longer exists.
  const selection = useMemo(
    () =>
      storedSelection?.pageId === page.id
        ? storedSelection.items.filter((item) =>
            item.kind === "frame"
              ? frameById.has(item.frameId)
              : indexes.get(item.frameId)?.nodes.has(item.layerId) === true,
          )
        : [],
    [frameById, indexes, page.id, storedSelection],
  );
  const select = useCallback<CanvasEditorApi["select"]>(
    (items, options) => {
      const stored = useCanvasEditorStore.getState().selection[work.id];
      const before = options?.from ?? (stored?.pageId === page.id ? stored.items : []);
      setStoredSelection(work.id, page.id, items);
      if (options?.record === false || readOnly) return;
      if (
        before.length === items.length &&
        before.every((item, at) => selectionKey(item) === selectionKey(items[at]!))
      )
        return;
      recorder.record(page.id, {
        undo: [{ kind: "selection", items: before }],
        redo: [{ kind: "selection", items }],
      });
    },
    [page.id, readOnly, recorder, setStoredSelection, work.id],
  );
  // A thread opened from another page's row opens once that page shows.
  const pendingComment = useRef<string | null>(null);
  useEffect(() => {
    setEditingText(null);
    setActiveCommentId(pendingComment.current);
    pendingComment.current = null;
    // Switching pages leaves text editing and open comments behind; each page has its camera.
  }, [page.id]);
  const openComment = useCallback<CanvasEditorApi["openComment"]>(
    (target) => {
      if (target) showHiddenCanvasComments(t);
      if (target?.pageId && target.pageId !== page.id && onSelectPage) {
        pendingComment.current = target.threadId;
        onSelectPage(target.pageId);
        return;
      }
      setActiveCommentId(target?.threadId ?? null);
    },
    [onSelectPage, page.id, t],
  );
  const viewportElement = useRef<HTMLElement | null>(null);
  const attachViewport = useCallback((element: HTMLElement | null) => {
    viewportElement.current = element;
  }, []);
  const focusCanvas = useCallback(
    () => viewportElement.current?.focus({ preventScroll: true }),
    [],
  );

  const fonts = useCanvasFonts(work.id, work.assets);
  // Previews resolve work images too, so a fill stack holding an image previews whole.
  const assetUrl = useCanvasAssetUrls(work.id, work.assets);
  const showBeside = useCanvasEditorStore((state) => state.showBeside);
  useEffect(
    () => (threadId ? showBeside(threadId, work.id) : undefined),
    [showBeside, threadId, work.id],
  );

  const elementFor = useCallback((item: CanvasSelectionItem) => {
    const dom = frames.current.get(item.frameId);
    if (!dom) return null;
    return item.kind === "frame" ? dom.root : dom.layer(item.layerId);
  }, []) as CanvasEditorApi["elementFor"];

  const registerFrame = useCallback(
    (frameId: string, dom: FrameDom | null) => {
      if (dom) frames.current.set(frameId, dom);
      else frames.current.delete(frameId);
      bumpDom();
    },
    [bumpDom],
  );

  const fail = useCallback(
    (cause: unknown) =>
      toastManager.add({
        type: "error",
        title: t("workspace:canvasOperationFailed"),
        description: cause instanceof Error ? cause.message : undefined,
      }),
    [t],
  );

  /**
   * The newest saved work. A queued send runs right after the previous one resolved, before
   * React re-renders, so it reads the cache the previous write updated, not the render's copy.
   */
  const latestWork = useCallback((): CanvasWork => {
    const rendered = workRef.current;
    const cached = client.getQueryData<CanvasWork>(canvasWorkQueryKey(rendered.id));
    return cached && Date.parse(cached.updatedAt) >= Date.parse(rendered.updatedAt)
      ? cached
      : rendered;
  }, [client]);
  /** One write: its saved work goes to the cache, and its own echo is not refetched. */
  const write = useCallback(
    <A,>(task: () => Promise<A>, savedWork?: (result: A) => CanvasWork) =>
      runCanvasWrite(client, workRef.current.id, task, savedWork),
    [client],
  );

  /** Sends one change, in order, and records how to revert it unless this is an undo/redo. */
  const send = useCallback(
    async (
      change: CanvasChange,
      targetPageId: string,
      record: boolean,
    ): Promise<CanvasChangeResult> => {
      const api = ensureNativeApi().canvas;
      const latest = latestWork();
      const before = latest.pages.find((item) => item.id === targetPageId);
      if (!before) throw new Error(t("workspace:canvasOperationFailed"));
      const base = { workId: latest.id, pageId: targetPageId };
      if (change.kind === "selection") {
        setStoredSelection(latest.id, targetPageId, change.items);
        return { work: latest, createdNodeIds: [] };
      }
      if (change.kind === "edit") {
        const previous = before.frames.find((frame) => frame.id === change.frameId);
        const result = await write(
          () =>
            api.editLayers({
              ...base,
              edit: {
                frameId: change.frameId,
                mutationId: mutationId(),
                operations: [...change.operations],
              },
            }),
          (saved) => saved.work,
        );
        const after = result.work.pages
          .find((item) => item.id === targetPageId)
          ?.frames.find((frame) => frame.id === change.frameId);
        if (record && previous && after)
          recorder.record(targetPageId, {
            undo: [
              {
                kind: "edit",
                frameId: change.frameId,
                operations: invertEdit(previous, change.operations, result.createdNodeIds, after),
              },
              ...deletedLayerRows(before, previous, change.operations),
            ],
            redo: [
              {
                kind: "edit",
                frameId: change.frameId,
                operations: replayableEdit(change.operations, result.createdNodeIds, after),
              },
            ],
          });
        return result;
      }
      if (change.kind === "layout") {
        const next = await write(() =>
          api.layout({
            ...base,
            frames: [...change.frames],
            ...(change.order ? { order: [...change.order] } : {}),
          }),
        );
        if (record)
          recorder.record(targetPageId, {
            undo: invertLayout(before, change.frames, change.order),
            redo: [change],
          });
        return { work: next, createdNodeIds: [] };
      }
      if (change.kind === "exports") {
        const next = await write(() =>
          api.layout({
            ...base,
            exportSettings: change.settings.map((patch) => ({
              key: patch.key,
              entries: patch.entries ? [...patch.entries] : null,
            })),
          }),
        );
        if (record)
          recorder.record(targetPageId, {
            undo: [invertExportSettings(before, change.settings)],
            redo: [change],
          });
        return { work: next, createdNodeIds: [] };
      }
      const next = await write(() =>
        api.restoreFrames({
          ...base,
          frames: [...change.frames],
          removeFrameIds: [...change.removeFrameIds],
          ...(change.comments?.length ? { comments: [...change.comments] } : {}),
        }),
      );
      if (record)
        recorder.record(targetPageId, { undo: invertRestore(before, change), redo: [change] });
      return { work: next, createdNodeIds: [] };
    },
    [latestWork, recorder, setStoredSelection, t, write],
  );

  const enqueue = useCallback(<A,>(task: () => Promise<A>): Promise<A> => {
    const next = queue.current.catch(() => {}).then(task);
    queue.current = next;
    return next;
  }, []);

  const run = useCallback<CanvasEditorApi["run"]>(
    (change, options) => {
      if (readOnly) return Promise.resolve(null);
      return enqueue(() => send(change, page.id, options?.record ?? true)).catch((cause) => {
        fail(cause);
        return null;
      });
    },
    [enqueue, fail, page.id, readOnly, send],
  );

  const replay = useCallback(
    (direction: "undo" | "redo") => {
      // A read-only canvas (archived, or a viewer) never writes, undo included.
      if (readOnly) return Promise.resolve();
      return enqueue(async () => {
        const result = await replayCanvasHistory(history, direction, (change, entryPage) =>
          send(change, entryPage, false),
        );
        if (result.status === "failed") fail(result.cause);
        if (result.status !== "done") return;
        // The step shows where it happened: on its page (switched to when it is another one),
        // with what it changed brought into view when it is off screen.
        const { pageId: target } = result.entry;
        const current = latestEditor.current;
        if (target !== current?.page.id && current?.selectPage) current.selectPage(target);
        useCanvasEditorStore.getState().requestReveal({
          workId: workRef.current.id,
          pageId: target,
          items: canvasHistoryTargets(result.entry, direction),
        });
      });
    },
    [enqueue, fail, history, readOnly, send],
  );

  /** Everything `task` changes through `run` becomes one undo step. */
  const batch = useCallback(
    async <A,>(task: () => Promise<A>): Promise<A> => {
      recorder.open();
      try {
        return await task();
      } finally {
        recorder.close();
      }
    },
    [recorder],
  );

  const previewStyles = useCallback<CanvasEditorApi["previewStyles"]>(
    (items, patch, options) => {
      const context = { fonts, assetUrl };
      for (const item of items) {
        const element = elementFor(item);
        if (!element) continue;
        for (const [property, value] of Object.entries(patch)) {
          if (value === null) {
            element.style.removeProperty(property);
            continue;
          }
          for (const [name, safe, priority] of sanitizeDesignStyle(`${property}:${value}`, context))
            element.style.setProperty(name, safe, priority);
        }
      }
      if (!options?.quiet) bumpDom();
    },
    [assetUrl, bumpDom, elementFor, fonts],
  );

  const discardPreview = useCallback((items: readonly CanvasSelectionItem[]) => {
    for (const item of items)
      frames.current.get(item.frameId)?.restore(item.kind === "frame" ? null : item.layerId);
  }, []);

  const commitStyles = useCallback(
    async (items: readonly CanvasSelectionItem[], patch: StylePatch) => {
      // The layer being typed into keeps its element until the edit ends (the inspector can
      // stay open beside it): the change shows on it now and is saved like any other.
      const typing = editingText
        ? items.filter((item) => selectionKey(item) === selectionKey(editingText))
        : [];
      if (typing.length > 0) previewStyles(typing, patch, { quiet: true });
      const byFrame = new Map<string, DesignLayerEdit[]>();
      for (const item of items) {
        const operations = byFrame.get(item.frameId) ?? [];
        byFrame.set(item.frameId, operations);
        operations.push(
          item.kind === "frame"
            ? { type: "set_frame_styles", styles: { ...patch } }
            : { type: "set_styles", nodeId: item.layerId, styles: { ...patch } },
        );
      }
      return batch(async () => {
        let saved = true;
        for (const [frameId, operations] of byFrame)
          if (!(await run({ kind: "edit", frameId, operations }))) saved = false;
        return saved;
      });
    },
    [batch, editingText, previewStyles, run],
  );

  // Commands are built once and read the editor as it is when they run.
  const commands = useMemo(
    () =>
      makeCanvasCommands(() => latestEditor.current!, {
        frameTitle: (number) => `${t("workspace:canvasFrame")} ${number}`,
        importImage: (input) =>
          runCanvasWrite(client, input.workId, () => ensureNativeApi().canvas.importImage(input)),
        saveCover: (cover) => {
          const workId = latestEditor.current!.work.id;
          return runCanvasWrite(
            client,
            workId,
            () => ensureNativeApi().canvas.update({ id: workId, cover }),
            (saved) => saved as CanvasWork,
          );
        },
        imageJob: (job) =>
          runCanvasJob(t("workspace:canvasAddingImage"), job, {
            failure: (cause) => ({
              title: t("workspace:canvasOperationFailed"),
              description: cause instanceof Error ? cause.message : undefined,
            }),
          }),
        fail,
      }),
    [client, fail, t],
  );

  const value = useMemo<CanvasEditorApi>(
    () => ({
      work,
      page,
      readOnly,
      threadId,
      selection,
      select,
      frame: (frameId) => frameById.get(frameId),
      layers: (frameId) => indexes.get(frameId),
      elementFor,
      registerFrame,
      domVersion,
      bumpDom,
      fonts,
      previewStyles,
      discardPreview,
      commitStyles,
      run,
      batch,
      discardBatch: () => recorder.discard(),
      undo: () => replay("undo"),
      redo: () => replay("redo"),
      commands,
      viewport: camera.viewport,
      setViewport,
      camera: liveCamera,
      cameraPlaced: camera.placed,
      editingText,
      setEditingText,
      openComment,
      activeCommentId,
      onAskAgent,
      selectPage: onSelectPage,
      openLibrary: onOpenLibrary,
      focusCanvas,
      attachViewport,
    }),
    [
      focusCanvas,
      attachViewport,
      onSelectPage,
      onOpenLibrary,
      openComment,
      activeCommentId,
      bumpDom,
      commands,
      commitStyles,
      discardPreview,
      domVersion,
      editingText,
      elementFor,
      fonts,
      frameById,
      indexes,
      liveCamera,
      onAskAgent,
      page,
      previewStyles,
      readOnly,
      registerFrame,
      replay,
      run,
      batch,
      recorder,
      select,
      selection,
      setViewport,
      threadId,
      camera,
      work,
    ],
  );
  // Before any effect or event handler of this render runs, commands see this render's editor.
  latestEditor.current = value;
  return <CanvasEditorContext.Provider value={value}>{children}</CanvasEditorContext.Provider>;
}
