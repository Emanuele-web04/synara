import type { DesignFrame } from "@synara/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "~/i18n";
import { claimShortcuts } from "~/keybindings";
import { screenToWorld } from "~/lib/designCanvas";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { useShallow } from "zustand/react/shallow";
import {
  selectionKey,
  useActiveAgentFrames,
  useCanvasActivityStore,
  useCanvasEditorStore,
  type CanvasSelectionItem,
} from "../canvasStores";
import { useCanvasAssetUrls } from "../canvasAssets";
import { CanvasAgentReveals } from "./CanvasAgentActivity";
import { CanvasCommentLayer } from "./CanvasComments";
import { useCanvasEditor } from "./CanvasEditorContext";
import { CANVAS_FRAME_LABEL_HEIGHT, CanvasFrameView } from "./CanvasFrameView";
import { CanvasOverlay, type CanvasOverlayHandle } from "./CanvasOverlay";
import { CanvasZoomMenu } from "./CanvasToolbar";
import {
  pasteIntoCanvas,
  readClipboard,
  readPaste,
  type CanvasPasteMode,
  type ClipboardContent,
} from "./canvasClipboard";
import { showCanvasContextMenu, showCanvasEmptyMenu } from "./canvasContextMenu";
import { showCanvasToast } from "./canvasToasts";
import {
  alignSelection,
  distributeSelection,
  resizeSelectionBy,
  resizeSelectionTo,
} from "../inspector/layoutActions";
import { inspectorModelOf } from "../inspector/useInspectorModel";
import { createCanvasGestureLayer, type CanvasGestureLayer } from "./canvasGestureLayer";
import { elementBox, framesWithBlockedLabels, screenToWorldRect } from "./canvasMeasure";
import { exportShortcutItems, makeCanvasExportActions } from "./canvasSelectionExport";
import { parentSelection } from "./canvasSelection";
import {
  CANVAS_OPACITY_DIGIT_MS,
  canvasKeyOf,
  isCanvasKeyTarget,
  matchCanvasShortcut,
  type CanvasShortcut,
} from "./canvasShortcuts";
import { useCanvasCameraCommands, useCanvasViewportCamera } from "./useCanvasCamera";
import {
  useCanvasGestures,
  type CanvasFrameDrafts,
  type CanvasPendingComment,
} from "./useCanvasGestures";
import { useCanvasAgentReveal } from "./useCanvasAgentReveal";
import { isCanvasTextEditChord, useCanvasTextEditing } from "./useCanvasTextEditing";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The canvas: frames on an infinite world under this client's camera, with selection chrome,
 * gestures, keyboard shortcuts, paste and drop and comments (the tool strip and the zoom menu
 * sit beside it, see CanvasEditorSurface). It paints the page's canvas colour, or the canvas
 * backdrop (`--canvas-backdrop`, the app's background with the muted tint) when the page sets
 * none. Gestures and the camera write to the
 * DOM while they run, so this tree renders when one starts or settles, never per pointer move.
 */
export function CanvasViewport({
  className,
  zoomOutside = false,
}: {
  className?: string;
  /**
   * The surrounding surface shows `CanvasZoomMenu` (the inspector's top row or the pane header),
   * so the canvas leaves its corner empty.
   */
  zoomOutside?: boolean;
}) {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const { work, page, readOnly, selection, select, editingText, camera, commands } = editor;
  const tool = useCanvasEditorStore((state) => state.tool);
  const setTool = useCanvasEditorStore((state) => state.setTool);
  const root = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const reveals = useRef<HTMLDivElement>(null);
  const gestureLayer = useRef<CanvasGestureLayer | null>(null);
  const overlay = useRef<CanvasOverlayHandle | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceRef = useRef(false);
  useLayoutEffect(() => {
    spaceRef.current = spaceHeld;
  }, [spaceHeld]);
  // Holding ⌥ measures from the selection to the hovered layer (or its parent).
  const [altHeld, setAltHeld] = useState(false);
  const [hover, setHover] = useState<CanvasSelectionItem | null>(null);
  const [drafts, setDrafts] = useState<CanvasFrameDrafts>({});
  const [pendingComment, setPendingComment] = useState<CanvasPendingComment | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const agentFrames = useActiveAgentFrames(work.id, page.id);
  // Same `${workId}/${pageId}` key as the activity store: which chat writes each active frame.
  const agentActivity = useCanvasActivityStore((state) => state.frames[`${work.id}/${page.id}`]);
  const assetUrl = useCanvasAssetUrls(work.id, work.assets);
  const renderContext = useMemo(
    () => ({ assetUrl, fonts: editor.fonts }),
    [assetUrl, editor.fonts],
  );

  // Hidden frames (the layers panel's eye) are not on the canvas at all.
  const frames = useMemo(
    () =>
      page.frames
        .filter((frame) => frame.hidden !== true)
        .map((frame) => ({ ...frame, ...drafts[frame.id] })),
    [drafts, page.frames],
  );
  const uiHidden = useCanvasEditorStore((state) => state.uiHidden);
  const frameById = useMemo(() => new Map(frames.map((frame) => [frame.id, frame])), [frames]);
  // Drafts give way once the saved document catches up with them.
  useEffect(() => {
    setDrafts((current) => {
      let changed = false;
      const next: Record<string, Partial<DesignFrame>> = {};
      for (const [id, draft] of Object.entries(current)) {
        const saved = page.frames.find((frame) => frame.id === id);
        if (!saved) {
          changed = true;
          continue;
        }
        const pending = Object.entries(draft).filter(
          ([key, value]) => saved[key as keyof DesignFrame] !== value,
        );
        if (pending.length !== Object.keys(draft).length) changed = true;
        if (pending.length) next[id] = Object.fromEntries(pending);
      }
      return changed ? next : current;
    });
  }, [page.frames]);

  useLayoutEffect(() => {
    gestureLayer.current = live.current ? createCanvasGestureLayer(live.current) : null;
    return () => gestureLayer.current?.clear();
  }, []);

  const text = useCanvasTextEditing();
  const panning = tool === "hand" || spaceHeld;
  const gestures = useCanvasGestures({
    root,
    gestureLayer,
    overlay,
    frames,
    tool,
    panning,
    spaceHeld: () => spaceRef.current,
    setDrafts,
    setHover,
    text,
    onComment: setPendingComment,
    onRenameFrame: setRenaming,
    onHandleDoubleClick: (axes, fill) =>
      void resizeSelectionTo(inspectorModelOf(editor), fill ? "fill" : "fit", axes),
    newText: t("workspace:canvasNewText"),
    countLabel: (count) => t("workspace:canvasInspectorSelectedCount", { count }),
  });
  const gestureRef = useRef(gestures);
  useLayoutEffect(() => {
    gestureRef.current = gestures;
  });
  const wheelPaused = useCallback(() => gestureRef.current.panning(), []);
  useCanvasViewportCamera({ root, world, pausedWheel: wheelPaused });
  const viewportElement = useCallback(() => root.current, []);
  const zoom = useCanvasCameraCommands(viewportElement);
  const exports = useMemo(() => makeCanvasExportActions(editor, t), [editor, t]);

  /** The camera's centre, in world pixels: where pastes and inserted images land. */
  const center = () => {
    const element = root.current!;
    return screenToWorld(camera.get(), element.clientWidth / 2, element.clientHeight / 2);
  };
  const pasteContent = async (content: ClipboardContent | null, mode: CanvasPasteMode) => {
    if (content) await pasteIntoCanvas(editor, commands, content, center(), mode);
  };
  const paste = (data: DataTransfer | null) => pasteContent(readPaste(data), "normal");
  /** ⌘⇧V, ⌘⇧R and the menus read the clipboard themselves: no paste event comes with them. */
  const pasteFromClipboard = async (mode: CanvasPasteMode) =>
    pasteContent(await readClipboard(), mode);

  /* ---------------------------------------------------------------- keyboard */

  /** The last opacity digit, while a second one can still make an exact value. */
  const digits = useRef<{ digit: number; time: number } | null>(null);

  const runShortcut = (shortcut: CanvasShortcut) => {
    switch (shortcut.id) {
      case "export-files":
        // ⌘⇧E exports the selection, else every node on the page with export rows.
        if (!gestures.active()) void exports.exportFiles(exportShortcutItems(editor));
        return;
      case "copy-png":
        return void exports.copyPng(selection);
      case "copy-code":
        return void exports.copyCode(selection[0]!, shortcut.format);
      case "undo":
        return void editor.undo();
      case "redo":
        return void editor.redo();
      case "duplicate":
        return void commands.duplicate();
      case "copy-styles":
        commands.copyStyles();
        return showCanvasToast(t("workspace:canvasToastStylesCopied"));
      case "paste-styles":
        if (!commands.canPasteStyles()) return;
        return void commands
          .pasteStyles()
          .then(() => showCanvasToast(t("workspace:canvasToastStylesPasted")));
      case "wrap":
        return void commands.wrap();
      case "frame-selection":
        return void commands.frameSelection();
      case "unlock-all":
        return void commands
          .unlockAll()
          .then(() => showCanvasToast(t("workspace:canvasToastUnlocked")));
      case "remove-flex":
        return void commands.removeFlex();
      case "clip-content":
        return void commands.toggleClip();
      case "text-align":
        return void commands.alignText(shortcut.align);
      case "text-format":
        return void commands.formatText(shortcut.format);
      case "text-step":
        return void commands.stepText(shortcut.step, shortcut.direction);
      case "select-others":
        return commands.selectOthers();
      case "paste-special":
        return void pasteFromClipboard(shortcut.mode);
      case "rename": {
        const only = selection[0];
        if (!only || readOnly) return;
        if (only.kind === "frame") return setRenaming(only.frameId);
        return useCanvasEditorStore
          .getState()
          .requestPanel({ kind: "rename", key: selectionKey(only) });
      }
      case "opacity-digit": {
        // 1 is 10% … 0 is 100%; a second digit within 600 ms makes it exact (4, 5 → 45%).
        const now = performance.now();
        const previous = digits.current;
        const exact = previous !== null && now - previous.time <= CANVAS_OPACITY_DIGIT_MS;
        digits.current = exact ? null : { digit: shortcut.digit, time: now };
        const percent = exact
          ? previous.digit * 10 + shortcut.digit
          : shortcut.digit === 0
            ? 100
            : shortcut.digit * 10;
        showCanvasToast(t("workspace:canvasToastOpacity", { percent }));
        return void commands.setOpacity(percent);
      }
      case "page": {
        const at = work.pages.findIndex((item) => item.id === page.id);
        const next = work.pages[at + shortcut.step];
        if (next && editor.selectPage) editor.selectPage(next.id);
        return;
      }
      case "frame-step": {
        const next = commands.stepFrame(shortcut.step);
        if (next) zoom.fit([next]);
        return;
      }
      case "dashboard":
        return editor.openLibrary?.();
      case "toggle-ui":
        return useCanvasEditorStore.getState().toggleUi();
      case "show-layers":
        return useCanvasEditorStore.getState().requestPanel({ kind: "layers" });
      case "collapse-layers":
        return useCanvasEditorStore.getState().requestPanel({ kind: "collapse" });
      case "toggle-comments": {
        const store = useCanvasEditorStore.getState();
        store.toggleComments();
        return showCanvasToast(
          t(
            useCanvasEditorStore.getState().commentsHidden
              ? "workspace:canvasToastCommentsHidden"
              : "workspace:canvasToastCommentsShown",
          ),
        );
      }
      case "ungroup":
        return void commands.ungroup();
      case "toggle-hidden":
        return void commands.toggleHidden();
      case "toggle-locked":
        return void commands.toggleLocked();
      case "copy":
        return void commands.copy();
      case "cut":
        return void commands.cut();
      case "select-all":
        return commands.selectSiblings();
      case "zoom":
        return zoom.zoomBy(shortcut.factor);
      case "zoom-100":
        return zoom.actualSize();
      case "fit-all":
        return zoom.fitAll();
      case "fit-selection":
        return zoom.fitSelection();
      case "delete":
        return void commands.remove();
      case "escape": {
        if (tool !== "move") return setTool("move");
        const only = selection.length === 1 ? selection[0]! : null;
        const parent =
          only && !shortcut.deselect ? parentSelection(editor.layers(only.frameId), only) : null;
        return select(parent ? [parent] : []);
      }
      case "select-parent":
        return commands.selectParent();
      case "enter": {
        const item = selection[0];
        if (!item || readOnly) return;
        if (item.kind === "layer" && text.start(item)) return;
        return commands.selectChildren();
      }
      case "cycle-sibling":
        return commands.cycleSibling(shortcut.step);
      case "add-flex":
        return void commands.addFlex();
      case "arrange":
        return void commands.arrange(shortcut.mode);
      case "nudge":
        return void commands.nudge(shortcut.dx, shortcut.dy);
      case "tool": {
        // Choosing the Text tool with one text layer selected edits it.
        const only = selection.length === 1 ? selection[0]! : null;
        if (shortcut.tool === "text" && only?.kind === "layer" && text.start(only)) return;
        return setTool(shortcut.tool);
      }
      case "hold-space":
        return setSpaceHeld(true);
      case "align":
        return void alignSelection(inspectorModelOf(editor), shortcut.mode);
      case "distribute":
        return void distributeSelection(inspectorModelOf(editor), shortcut.axis);
      case "resize-to":
        return void resizeSelectionTo(inspectorModelOf(editor), shortcut.mode);
      case "resize-by":
        return void resizeSelectionBy(inspectorModelOf(editor), shortcut.dw, shortcut.dh);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editingText) return;
    if (event.key === "Alt") setAltHeld(true);
    if (event.key === "Escape" && gestures.cancel()) {
      event.preventDefault();
      return;
    }
    if (!isCanvasKeyTarget(event.target, root.current!)) return;
    const shortcut = matchCanvasShortcut(canvasKeyOf(event, isMac), {
      selection: selection.length,
      singleLayer: selection.length === 1 && selection[0]!.kind === "layer",
      readOnly,
      spaceHeld,
    });
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();
    runShortcut(shortcut);
  };
  // The app's shortcuts listen on the window and see every key first. While the canvas has
  // focus it claims the presses it handles itself (a live text edit's ⌘B / ⌘I / ⌘U and undo,
  // otherwise its own shortcuts), so ⌘B bolds instead of toggling the sidebar. Elsewhere the
  // app's shortcuts are untouched.
  const claim = useRef({ editing: false, selection: 0, singleLayer: false, readOnly, spaceHeld });
  useLayoutEffect(() => {
    claim.current = {
      editing: editingText !== null,
      selection: selection.length,
      singleLayer: selection.length === 1 && selection[0]!.kind === "layer",
      readOnly,
      spaceHeld,
    };
  });
  useEffect(
    () =>
      claimShortcuts((event) => {
        const element = root.current;
        const target = event.target;
        if (!element || !(target instanceof Node) || !element.contains(target)) return false;
        const state = claim.current;
        if (state.editing) return isCanvasTextEditChord(event, isMac);
        if (!isCanvasKeyTarget(target, element)) return false;
        return matchCanvasShortcut(canvasKeyOf(event, isMac), state) !== null;
      }),
    [],
  );
  // The canvas shows what an agent works on: a frame it starts writing off screen comes into view,
  // unless the user is mid-gesture, typing into a layer or writing a comment.
  const pendingRef = useRef(pendingComment);
  useLayoutEffect(() => {
    pendingRef.current = pendingComment;
  });
  useCanvasAgentReveal({
    root,
    workId: work.id,
    pageId: page.id,
    frames,
    cameraPlaced: editor.cameraPlaced,
    camera,
    commands: zoom,
    busy: () => gestureRef.current.active() || claim.current.editing || pendingRef.current !== null,
  });
  useEffect(() => {
    if (!altHeld) return;
    const release = (event: KeyboardEvent) => {
      if (event.key === "Alt") setAltHeld(false);
    };
    const blur = () => setAltHeld(false);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
    };
  }, [altHeld]);
  useEffect(() => {
    if (!spaceHeld) return;
    const release = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
    };
  }, [spaceHeld]);

  /* ---------------------------------------------------------------- paste and drop */

  const pasteRef = useRef(paste);
  useLayoutEffect(() => {
    pasteRef.current = paste;
  });
  useEffect(() => {
    const element = root.current!;
    const onPaste = (event: ClipboardEvent) => {
      if (editingText) return;
      if (document.activeElement !== element && !element.contains(document.activeElement)) return;
      event.preventDefault();
      void pasteRef.current(event.clipboardData);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [editingText]);

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("image/"));
    if (!file || readOnly) return;
    event.preventDefault();
    const box = root.current!.getBoundingClientRect();
    const at = screenToWorld(camera.get(), event.clientX - box.left, event.clientY - box.top);
    void commands.placeImage(file, at, center());
  };

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    // A right-click in a popup the canvas's controls opened reaches here through the portal.
    if (!root.current?.contains(event.target as Node)) return;
    event.preventDefault();
    if (tool !== "move" || (event.target as HTMLElement).closest("[data-canvas-comments]")) return;
    // Right-click selects what is under the pointer (unless already selected).
    const label = (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-frame-label]");
    const pressed: CanvasSelectionItem | null = label
      ? { kind: "frame", frameId: label.dataset.canvasFrameLabel! }
      : gestures.hitAt(event.clientX, event.clientY, isMac ? event.metaKey : event.ctrlKey);
    if (!pressed) {
      // Empty canvas: paste, step through the frames, show or hide the UI.
      if (selection.length) select([]);
      return void showCanvasEmptyMenu({
        t,
        position: { x: event.clientX, y: event.clientY },
        readOnly,
        hasFrames: page.frames.length > 0,
        uiHidden,
        onPaste: () => void pasteFromClipboard("normal"),
        onFrameStep: (step) => {
          const next = commands.stepFrame(step);
          if (next) zoom.fit([next]);
        },
        onToggleUi: () => useCanvasEditorStore.getState().toggleUi(),
      });
    }
    if (!selection.some((item) => selectionKey(item) === selectionKey(pressed))) select([pressed]);
    const position = { x: event.clientX, y: event.clientY };
    // The menu reads the editor once the new selection has rendered.
    requestAnimationFrame(
      () =>
        void showCanvasContextMenu({
          commands,
          t,
          position,
          onPaste: (mode) => void pasteFromClipboard(mode),
          layersAt: gestures.layersAt(position.x, position.y),
          onRename: (item) =>
            item.kind === "frame"
              ? setRenaming(item.frameId)
              : useCanvasEditorStore
                  .getState()
                  .requestPanel({ kind: "rename", key: selectionKey(item) }),
        }),
    );
  };

  /* ---------------------------------------------------------------- render */

  // A frame is renamed in its label. A stable callback keeps the memoised frames still.
  const editorRef = useRef(editor);
  useLayoutEffect(() => {
    editorRef.current = editor;
  });
  const renameFrame = useCallback((frameId: string, title: string | null) => {
    setRenaming(null);
    const value = title?.trim().slice(0, 120);
    const current = editorRef.current;
    if (value && value !== current.frame(frameId)?.title)
      void current.run({ kind: "layout", frames: [{ id: frameId, title: value }] });
  }, []);

  // Labels that would cover a neighbouring frame stay hidden (unless the frame is selected).
  const labelBlockKey = frames
    .map((frame) => `${frame.id}:${frame.x},${frame.y},${frame.width},${frame.height}`)
    .join("|");
  const blockedLabels = useMemo(
    () => framesWithBlockedLabels(frames, editor.viewport.zoom, CANVAS_FRAME_LABEL_HEIGHT),
    // The key stands for the frames' boxes, which are all the result depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelBlockKey, editor.viewport.zoom],
  );
  const selectedFrames = new Set(
    selection.filter((item) => item.kind === "frame").map((item) => item.frameId),
  );
  const hoveredFrame = hover?.kind === "frame" ? hover.frameId : null;
  // Frames an agent is writing, named by the provider of the chat writing each one. The
  // shallow-compared list keeps unrelated chat summaries from re-rendering the canvas.
  const agentFrameIds = [...agentFrames];
  const agentProviders = useStore(
    useShallow((state) =>
      agentFrameIds.map((frameId) => {
        const threadId = agentActivity?.[frameId]?.threadId;
        return threadId
          ? state.sidebarThreadSummaryById[threadId]?.modelSelection.provider
          : undefined;
      }),
    ),
  );
  const agentNames = new Map(
    agentFrameIds.flatMap((frameId, index) => {
      const provider = agentProviders[index];
      return provider ? [[frameId, PROVIDER_DISPLAY_NAMES[provider]] as const] : [];
    }),
  );
  const agentKey = agentFrameIds.join(",");
  // A stable set, so the memoised overlay re-renders only when the active frames change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const agentFrameSet = useMemo(() => new Set(agentFrameIds), [agentKey]);
  const worldRect = (frameId: string, layerId: string) => {
    const element = editor.elementFor({ kind: "layer", frameId, layerId });
    const box =
      element && root.current ? elementBox(element, root.current.getBoundingClientRect()) : null;
    return box ? screenToWorldRect(box, camera.get()) : null;
  };

  return (
    <div
      ref={root}
      tabIndex={0}
      role="application"
      aria-label={t("workspace:designCanvas")}
      data-canvas-viewport=""
      data-canvas-page={page.id}
      style={{ "--canvas-page-color": page.color } as React.CSSProperties}
      className={cn(
        "relative size-full touch-none overflow-hidden bg-[var(--canvas-page-color,var(--canvas-backdrop))] outline-none select-none",
        panning
          ? "cursor-grab data-[canvas-gesture=pan]:cursor-grabbing"
          : tool === "move"
            ? "cursor-default"
            : "cursor-crosshair",
        className,
      )}
      onKeyDown={onKeyDown}
      onPointerDown={gestures.onPointerDown}
      onPointerMove={(event) => {
        if (!gestures.active() && event.altKey !== altHeld) setAltHeld(event.altKey);
        gestures.onPointerMove(event);
      }}
      onPointerUp={gestures.onPointerUp}
      onPointerCancel={gestures.onPointerCancel}
      onPointerLeave={gestures.onPointerLeave}
      onDragOver={(event) => {
        if ([...event.dataTransfer.items].some((item) => item.kind === "file"))
          event.preventDefault();
      }}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
    >
      {/* The camera transform is written by useCanvasViewportCamera, outside React. */}
      <div ref={world} className="absolute top-0 left-0 origin-top-left">
        {frames.map((frame) => (
          <CanvasFrameView
            key={frame.id}
            frame={frame}
            context={renderContext}
            zoom={editor.viewport.zoom}
            selected={selectedFrames.has(frame.id)}
            hovered={hoveredFrame === frame.id}
            agentActive={agentFrames.has(frame.id)}
            agentName={agentNames.get(frame.id) ?? null}
            cover={work.cover?.pageId === page.id && work.cover.frameId === frame.id}
            labelHidden={blockedLabels.has(frame.id)}
            canRename={!readOnly}
            editingLayerId={editingText?.frameId === frame.id ? editingText.layerId : null}
            renaming={renaming === frame.id}
            onRename={renameFrame}
            onRegister={editor.registerFrame}
          />
        ))}
      </div>
      <div ref={reveals} className="pointer-events-none absolute inset-0" aria-hidden />
      <CanvasAgentReveals editor={editor} container={reveals} viewport={root} />
      <CanvasOverlay
        root={root}
        handle={overlay}
        frames={frames}
        hover={hover}
        altHeld={altHeld}
        agentFrames={agentFrameSet}
      />
      <div
        ref={live}
        data-canvas-gesture-layer=""
        className="pointer-events-none absolute inset-0"
        aria-hidden
      />
      {!zoomOutside && !uiHidden && (
        <div className="absolute end-2 bottom-2" data-canvas-ui="" data-canvas-zoom-corner="">
          <CanvasZoomMenu viewportElement={viewportElement} />
        </div>
      )}
      <CanvasCommentLayer
        frameRect={(frameId) => {
          const frame = frameById.get(frameId);
          return frame
            ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
            : null;
        }}
        layerRect={worldRect}
        pending={pendingComment}
        onPendingDone={() => {
          setPendingComment(null);
          setTool("move");
        }}
      />
    </div>
  );
}
