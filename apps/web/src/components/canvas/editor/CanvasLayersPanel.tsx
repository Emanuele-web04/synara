import type { DesignFrame } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { CentralIcon } from "~/lib/central-icons";
import {
  EyeOpenIcon,
  FrameToolIcon,
  ImageIcon,
  RectangleIcon,
  TextToolIcon,
  type LucideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { EXPLORER_ROW_PROPS, useExplorerListNavigation } from "../../chat/explorerListNavigation";
import { IconButton } from "../../ui/icon-button";
import {
  setTreeRowDragImage,
  TREE_ROW_REVEAL_CLASS_NAME,
  TreeRow,
  treeRowIndent,
  TreeRowRenameInput,
  TreeSectionHeader,
  type TreeRowRun,
} from "../../ui/TreeRow";
import {
  selectionKey,
  useActiveAgentFrames,
  useCanvasEditorStore,
  type CanvasSelectionItem,
} from "../canvasStores";
import { CanvasAgentIconSlot } from "./CanvasAgentActivity";
import { pasteIntoCanvas, readClipboard } from "./canvasClipboard";
import { showCanvasContextMenu } from "./canvasContextMenu";
import { canvasShortcutLabelFor } from "./canvasShortcuts";
import { ShortcutTooltip } from "./ShortcutTooltip";
import { useCanvasEditor } from "./CanvasEditorContext";
import {
  LAYER_AUTOSCROLL_EDGE,
  LAYER_DEPTH_STEP,
  LAYER_INDENT,
  LAYER_INSIDE_MAX_SPEED,
  resolveLayerDrop,
  type DropRow,
  type LayerDrop,
} from "./canvasLayerDrop";
import {
  isLayerHidden,
  isLayerItem,
  isLayerLocked,
  isTextOnly,
  LAYER_HIDDEN_ATTRIBUTE,
  LAYER_LOCKED_ATTRIBUTE,
  layerChain,
  layerFlag,
  layerLabel,
  layerSiblings,
  type LayerIndex,
} from "./canvasSelection";
import { selectionWorldRects, useCanvasCameraCommands } from "./useCanvasCamera";

type Row = DropRow & {
  item: CanvasSelectionItem;
  label: string;
  kind: "frame" | "image" | "text" | "container" | "svg";
  expandable: boolean;
  hidden: boolean;
  locked: boolean;
  /** Under a hidden or locked ancestor (the one is dimmed, the other marked with a dot). */
  hiddenByParent: boolean;
  lockedByParent: boolean;
};
type PickModifiers = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

/** An inline SVG's row: one leaf with the vector glyph the page icons also use. */
export const SvgLayerIcon: LucideIcon = ({ className }) => (
  <CentralIcon name="bezier" className={className} />
);

const ROW_ICONS = {
  frame: FrameToolIcon,
  container: RectangleIcon,
  image: ImageIcon,
  text: TextToolIcon,
  svg: SvgLayerIcon,
} as const;
/** Locked rows, and rows under a locked parent, cannot be selected. */
const pickable = (row: Pick<Row, "locked" | "lockedByParent">) =>
  !row.locked && !row.lockedByParent;
/** The row's own indent (16 px per level). */
const indentOf = (depth: number) => treeRowIndent(depth, LAYER_INDENT);

/**
 * The layers panel: frames and element layers in
 * paint order (front first), synced with the canvas. Shift selects a range, Cmd/Ctrl toggles,
 * double-click or ⌘R renames inline, double-clicking the icon centres the camera on it. Rows
 * drag to reorder or nest, several at once and across frames: the top or bottom 24% drops beside
 * a row, its middle inside it only while the pointer moves slowly, and sideways 15 px steps pick
 * the depth. Frames rename, reorder, hide and lock too. Locked rows cannot be selected; a lock
 * inherited from a parent shows a dot, and everything under a hidden layer is dimmed.
 */
export function CanvasLayersPanel({ className }: { className?: string }) {
  const { t } = useTranslation();
  const editor = useCanvasEditor();
  const { page, selection, select, commands } = editor;
  const setPanelHover = useCanvasEditorStore((state) => state.setPanelHover);
  const panelRequest = useCanvasEditorStore((state) => state.panelRequest);
  const selected = useMemo(() => new Set(selection.map(selectionKey)), [selection]);
  const agentFrames = useActiveAgentFrames(editor.work.id, editor.page.id);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<LayerDrop | null>(null);
  const anchor = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const motion = useRef<{ x: number; y: number; time: number; speed: number } | null>(null);
  const navigate = useExplorerListNavigation();

  /** The canvas this panel belongs to, for centring the camera on a row. */
  const viewportOf = () => {
    const frame = editor.page.frames[0];
    const root = frame ? editor.elementFor({ kind: "frame", frameId: frame.id }) : null;
    const owner = root?.getRootNode();
    const host = owner instanceof ShadowRoot ? owner.host : null;
    return host?.closest<HTMLElement>("[data-canvas-viewport]") ?? null;
  };
  const camera = useCanvasCameraCommands(viewportOf);

  // Selected layers open their ancestors so they are visible in the tree.
  const forcedOpen = useMemo(() => {
    const open = new Set<string>();
    for (const item of selection) {
      open.add(`frame:${item.frameId}`);
      if (item.kind !== "layer") continue;
      const index = editor.layers(item.frameId);
      if (!index) continue;
      for (const id of layerChain(index, item.layerId).slice(0, -1))
        open.add(`layer:${item.frameId}:${id}`);
    }
    return open;
  }, [editor, selection]);

  const rows = useMemo(() => {
    const isOpen = (key: string) =>
      collapsed[key] === false || (collapsed[key] !== true && forcedOpen.has(key));
    const result: Row[] = [];
    const visit = (
      frame: DesignFrame,
      index: LayerIndex,
      id: string,
      depth: number,
      parent: string,
    ) => {
      const node = index.nodes.get(id);
      if (node?.type !== "element") return;
      const item: CanvasSelectionItem = { kind: "layer", frameId: frame.id, layerId: id };
      const key = selectionKey(item);
      const textOnly = isTextOnly(index, id);
      const children = textOnly
        ? []
        : node.children.filter((child) => index.nodes.get(child)?.type === "element");
      const parentId = index.parent.get(id) ?? null;
      const open = isOpen(key);
      result.push({
        item,
        key,
        depth,
        parent,
        // Nothing drops into an inline SVG: its shapes are part of it.
        container: !textOnly && node.tag !== "img" && node.tag !== "svg",
        open: open && children.length > 0,
        label: layerLabel(index, id),
        kind:
          node.tag === "img"
            ? "image"
            : node.tag === "svg"
              ? "svg"
              : textOnly
                ? "text"
                : "container",
        expandable: children.length > 0,
        hidden: layerFlag(index, id, LAYER_HIDDEN_ATTRIBUTE),
        locked: layerFlag(index, id, LAYER_LOCKED_ATTRIBUTE),
        hiddenByParent:
          frame.hidden === true || (parentId !== null && isLayerHidden(index, parentId)),
        lockedByParent:
          frame.locked === true || (parentId !== null && isLayerLocked(index, parentId)),
      });
      // Later children paint on top, so the panel lists them first.
      if (open)
        for (const child of children.toReversed()) visit(frame, index, child, depth + 1, key);
    };
    for (const frame of page.frames.toReversed()) {
      const index = editor.layers(frame.id);
      const item: CanvasSelectionItem = { kind: "frame", frameId: frame.id };
      const key = selectionKey(item);
      const open = isOpen(key);
      result.push({
        item,
        key,
        depth: 0,
        parent: null,
        container: true,
        open: open && frame.layers.roots.length > 0,
        label: frame.title,
        kind: "frame",
        expandable: frame.layers.roots.length > 0,
        hidden: frame.hidden === true,
        locked: frame.locked === true,
        hiddenByParent: false,
        lockedByParent: false,
      });
      if (index && open)
        for (const id of frame.layers.roots.toReversed()) visit(frame, index, id, 1, key);
    }
    return result;
  }, [collapsed, editor, forcedOpen, page.frames]);
  const isOpen = (key: string) =>
    collapsed[key] === false || (collapsed[key] !== true && forcedOpen.has(key));

  // Reveal the canvas selection in the list.
  useEffect(() => {
    const first = selection[0];
    if (!first) return;
    list.current
      ?.querySelector(`[data-layer-row="${CSS.escape(selectionKey(first))}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  // ⌥L collapses every row; ⌘R renames the selected row in place.
  const handledRequest = useRef(panelRequest?.nonce ?? 0);
  useEffect(() => {
    if (!panelRequest || panelRequest.nonce === handledRequest.current) return;
    handledRequest.current = panelRequest.nonce;
    if (panelRequest.kind === "collapse") collapseAll();
    else if (panelRequest.kind === "rename" && panelRequest.key) setRenaming(panelRequest.key);
    // `collapseAll` reads the page's frames, which are a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.page.frames, panelRequest]);

  /** Closes every frame and layer row (⌥L, and the panel's own menu). */
  function collapseAll() {
    const all: Record<string, boolean> = {};
    for (const frame of editor.page.frames) {
      all[`frame:${frame.id}`] = true;
      for (const node of frame.layers.nodes)
        if (node.type === "element") all[`layer:${frame.id}:${node.id}`] = true;
    }
    setCollapsed(all);
  }

  /** The row's key and the keys of every element layer under it, open rows or not. */
  const subtreeKeys = (row: Row): string[] => {
    const { frameId } = row.item;
    const index = editor.layers(frameId);
    const frame = editor.frame(frameId);
    if (!index || !frame) return [row.key];
    const keys = [row.key];
    const visit = (id: string) => {
      const node = index.nodes.get(id);
      if (node?.type !== "element") return;
      keys.push(`layer:${frameId}:${id}`);
      for (const child of node.children) visit(child);
    };
    if (isLayerItem(row.item)) {
      const node = index.nodes.get(row.item.layerId);
      for (const child of node?.type === "element" ? node.children : []) visit(child);
    } else for (const id of frame.layers.roots) visit(id);
    return keys;
  };

  const pick = (row: Row, event: PickModifiers) => {
    // Locked layers are not selectable.
    if (!pickable(row)) return;
    if (event.shiftKey && anchor.current) {
      const from = rows.findIndex((entry) => entry.key === anchor.current);
      const to = rows.findIndex((entry) => entry.key === row.key);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        select(
          rows
            .slice(start, end + 1)
            .filter(pickable)
            .map((entry) => entry.item),
        );
        return;
      }
    }
    anchor.current = row.key;
    if (event.metaKey || event.ctrlKey)
      select(
        selected.has(row.key)
          ? selection.filter((entry) => selectionKey(entry) !== row.key)
          : [...selection, row.item],
      );
    else select([row.item]);
  };

  /** The rows a drag moves: the whole selection when the dragged row is part of it. */
  const draggedRows = (key: string) => {
    const row = rows.find((entry) => entry.key === key);
    if (!row) return [];
    if (!selected.has(key)) return [row];
    return rows.filter((entry) => selected.has(entry.key) && entry.item.kind === row.item.kind);
  };

  const commitDrop = async (sources: readonly Row[], target: LayerDrop) => {
    const byKey = new Map(rows.map((entry) => [entry.key, entry]));
    if (sources[0]?.item.kind === "frame") {
      // The list is front-most first; a frame dropped below another paints behind it.
      const moving = sources.map((source) => source.item.frameId).toReversed();
      const kept = editor.page.frames.map((frame) => frame.id).filter((id) => !moving.includes(id));
      const below = target.below ? byKey.get(target.below)?.item.frameId : undefined;
      const at = below ? kept.indexOf(below) : kept.length;
      const order = [...kept.slice(0, at), ...moving, ...kept.slice(at)];
      if (order.some((id, index) => editor.page.frames[index]?.id !== id))
        await commands.orderFrames(order);
      return;
    }
    const parent = byKey.get(target.parent);
    if (!parent) return;
    const frameId = parent.item.frameId;
    const parentId = parent.item.kind === "frame" ? null : parent.item.layerId;
    const keys = new Set(sources.map((source) => source.key));
    // Back to front, so the moved layers keep their paint order; a row moved with its parent
    // goes with it.
    const layers = sources
      .filter((source) => {
        for (let up = source.parent; up; up = byKey.get(up)?.parent ?? null)
          if (keys.has(up)) return false;
        return true;
      })
      .map((source) => source.item)
      .filter(isLayerItem)
      .toReversed();
    // Visually below a row means just behind it; past a moving row, behind the next one.
    let beforeId: string | undefined;
    const belowRow = target.below ? byKey.get(target.below) : undefined;
    if (belowRow && isLayerItem(belowRow.item)) {
      const index = editor.layers(frameId);
      const frame = editor.frame(frameId);
      if (index && frame) {
        const { siblings } = layerSiblings(index, frame.layers.roots, belowRow.item.layerId);
        const at = siblings.indexOf(belowRow.item.layerId);
        beforeId = siblings.slice(at).find((id) => !keys.has(`layer:${frameId}:${id}`));
      }
    }
    if (layers.length) await commands.moveLayers(layers, { frameId, parentId, beforeId });
  };

  const flagRow = (row: Row, name: string, on: boolean) => {
    if (isLayerItem(row.item)) return commands.setFlag([row.item], name, on);
    return editor.run({
      kind: "layout",
      frames: [
        {
          id: row.item.frameId,
          ...(name === LAYER_HIDDEN_ATTRIBUTE ? { hidden: on } : { locked: on }),
        },
      ],
    });
  };

  /** Opens or closes a row; `deep` (Alt-click) takes the whole subtree the same way. */
  const toggle = (row: Row, deep = false) => {
    const close = isOpen(row.key);
    const keys = deep ? subtreeKeys(row) : [row.key];
    setCollapsed((current) => ({
      ...current,
      ...Object.fromEntries(keys.map((key) => [key, close])),
    }));
  };

  /** Tab while renaming: the rename moves on to the next (or previous) row that can take it. */
  const renameNext = (from: string, backward: boolean) => {
    const at = rows.findIndex((entry) => entry.key === from);
    const step = backward ? -1 : 1;
    for (let next = at + step; next >= 0 && next < rows.length; next += step) {
      const row = rows[next]!;
      if (row.locked || row.lockedByParent) continue;
      select([row.item]);
      setRenaming(row.key);
      return;
    }
  };
  const focusRow = (key: string) =>
    list.current?.querySelector<HTMLElement>(`[data-layer-row="${CSS.escape(key)}"]`)?.focus();

  /** Double-clicking a row's icon centres the camera on it. */
  const centre = (row: Row) => {
    const viewport = viewportOf();
    if (!viewport) return;
    const [rect] = selectionWorldRects(editor, [row.item], viewport);
    if (rect) camera.centre({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in the rename field or on a row's buttons stay with them.
    const key = (event.target as HTMLElement).getAttribute("data-layer-row");
    const at = key ? rows.findIndex((entry) => entry.key === key) : -1;
    const row = rows[at];
    if (!row) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(row, event);
    } else if (event.key === "ArrowRight" && row.expandable && !isOpen(row.key)) {
      event.preventDefault();
      toggle(row);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.expandable && isOpen(row.key)) toggle(row);
      else {
        const parent = rows.slice(0, at).findLast((entry) => entry.depth < row.depth);
        if (parent) focusRow(parent.key);
      }
    } else navigate(event);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>, at: number) => {
    if (!dragging) return;
    event.preventDefault();
    const element = list.current;
    const box = event.currentTarget.getBoundingClientRect();
    // How fast the pointer moves: "inside" needs it slow.
    const now = performance.now();
    const last = motion.current;
    const distance = last ? Math.hypot(event.clientX - last.x, event.clientY - last.y) : 0;
    const elapsed = last ? Math.max(1, now - last.time) : 1;
    const speed = last ? last.speed * 0.6 + (distance / elapsed) * 0.4 : 0;
    motion.current = { x: event.clientX, y: event.clientY, time: now, speed };
    // The tree scrolls within 20 px of its edges.
    if (element) {
      const edges = element.getBoundingClientRect();
      if (event.clientY < edges.top + LAYER_AUTOSCROLL_EDGE) element.scrollTop -= 6;
      else if (event.clientY > edges.bottom - LAYER_AUTOSCROLL_EDGE) element.scrollTop += 6;
    }
    // Depth is read from the row's own edge (rows are inset from the panel's).
    const left = box.left;
    const sources = draggedRows(dragging);
    const next = resolveLayerDrop({
      rows,
      at,
      ratio: (event.clientY - box.top) / box.height,
      depth: Math.floor((event.clientX - left - indentOf(0)) / LAYER_DEPTH_STEP),
      slow: speed < LAYER_INSIDE_MAX_SPEED,
      frameOnly: sources[0]?.item.kind === "frame",
      dragged: new Set(sources.map((source) => source.key)),
    });
    setDrop((current) =>
      current &&
      next &&
      current.parent === next.parent &&
      current.below === next.below &&
      current.line.key === next.line.key &&
      current.line.edge === next.line.edge &&
      current.depth === next.depth
        ? current
        : next,
    );
  };

  // Rows inside a selected frame or layer take the row hover tone.
  const tinted = new Set<string>();
  let selectedDepth: number | null = null;
  for (const row of rows) {
    if (selectedDepth !== null && row.depth <= selectedDepth) selectedDepth = null;
    if (selected.has(row.key)) selectedDepth ??= row.depth;
    else if (selectedDepth !== null) tinted.add(row.key);
  }
  // Consecutive filled rows (selected or tinted) read as one block: square corners between them.
  const runs = new Map<string, TreeRowRun>();
  const filled = (row: Row | undefined) =>
    row !== undefined && (selected.has(row.key) || tinted.has(row.key));
  rows.forEach((row, at) => {
    if (!filled(row)) return;
    const before = filled(rows[at - 1]);
    const after = filled(rows[at + 1]);
    if (before && after) runs.set(row.key, "middle");
    else if (after) runs.set(row.key, "start");
    else if (before) runs.set(row.key, "end");
  });
  // One tab stop for the tree: the first selected row, else the first row.
  const tabStop = rows.find((row) => selected.has(row.key))?.key ?? rows[0]?.key;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <TreeSectionHeader title={t("workspace:canvasLayers")} className="mt-1.5" />
      <div
        ref={list}
        role="tree"
        aria-label={t("workspace:canvasLayers")}
        className="min-h-0 flex-1 overflow-y-auto pb-2"
        onMouseLeave={() => setPanelHover(null)}
        onKeyDown={onTreeKeyDown}
        onContextMenu={(event) => {
          // The panel's empty area (below the rows) has its own menu.
          if ((event.target as HTMLElement).closest("[data-layer-row]")) return;
          event.preventDefault();
          void ensureNativeApi()
            .contextMenu.show(
              [{ id: "collapse-all", label: t("workspace:canvasLayersCollapseAll") }],
              {
                x: event.clientX,
                y: event.clientY,
              },
            )
            .then((clicked) => {
              if (clicked === "collapse-all") collapseAll();
            });
        }}
      >
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-ui-sm text-muted-foreground">
            {t("workspace:canvasLayersEmpty")}
          </p>
        ) : (
          rows.map((row, at) => {
            const Icon = ROW_ICONS[row.kind];
            const isSelected = selected.has(row.key);
            const writable = !editor.readOnly;
            const lockedHere = row.locked || row.lockedByParent;
            const lineHere = drop?.line.key === row.key ? drop.line.edge : null;
            return (
              <TreeRow
                key={row.key}
                {...EXPLORER_ROW_PROPS}
                role="treeitem"
                aria-selected={isSelected}
                aria-disabled={lockedHere || undefined}
                aria-expanded={row.expandable ? isOpen(row.key) : undefined}
                aria-level={row.depth + 1}
                tabIndex={row.key === tabStop ? 0 : -1}
                data-layer-row={row.key}
                draggable={writable && renaming !== row.key && !lockedHere}
                indent={indentOf(row.depth)}
                selected={isSelected}
                tinted={tinted.has(row.key)}
                run={runs.get(row.key)}
                actionsPinned={row.locked || row.hidden || row.lockedByParent}
                muted={row.hidden || row.hiddenByParent}
                className={cn(dragging === row.key && "opacity-40")}
                drop={lineHere}
                dropIndent={
                  lineHere && lineHere !== "inside" && drop ? indentOf(drop.depth) : undefined
                }
                disclosure={
                  row.expandable
                    ? { open: isOpen(row.key), onToggle: (deep) => toggle(row, deep) }
                    : null
                }
                // A frame an agent is working on shows the activity indicator instead of its icon.
                icon={
                  row.kind === "frame" ? (
                    <CanvasAgentIconSlot
                      active={agentFrames.has(row.item.frameId)}
                      scope="frame"
                      icon={<Icon className="size-3.5" />}
                    />
                  ) : (
                    <Icon className="size-3.5" />
                  )
                }
                onIconDoubleClick={() => centre(row)}
                label={row.label}
                editor={
                  renaming === row.key ? (
                    <TreeRowRenameInput
                      defaultValue={row.label}
                      label={t("workspace:canvasMenuRename")}
                      maxLength={120}
                      onCancel={() => setRenaming(null)}
                      onTab={(backward) => renameNext(row.key, backward)}
                      onDone={editor.focusCanvas}
                      onCommit={(value) => {
                        const item = row.item;
                        setRenaming(null);
                        const title = value.trim();
                        if (title === row.label) return;
                        if (isLayerItem(item)) void commands.rename(item, value);
                        else if (title)
                          void editor.run({
                            kind: "layout",
                            frames: [{ id: item.frameId, title: title.slice(0, 120) }],
                          });
                      }}
                    />
                  ) : undefined
                }
                actions={
                  writable ? (
                    <>
                      {row.lockedByParent && !row.locked ? (
                        // A lock inherited from a parent shows a dot.
                        <span
                          role="img"
                          aria-label={t("workspace:canvasLayerInheritedLock")}
                          data-inherited-lock=""
                          className="flex size-6 items-center justify-center"
                        >
                          <span className="size-1 rounded-full bg-muted-foreground" />
                        </span>
                      ) : (
                        <LayerFlagButton
                          label={
                            row.locked
                              ? t("workspace:canvasMenuUnlock")
                              : t("workspace:canvasMenuLock")
                          }
                          active={row.locked}
                          shortcut={canvasShortcutLabelFor({ id: "toggle-locked" })}
                          onClick={() => void flagRow(row, LAYER_LOCKED_ATTRIBUTE, !row.locked)}
                        >
                          <CentralIcon name={row.locked ? "lock" : "unlocked"} className="size-3" />
                        </LayerFlagButton>
                      )}
                      <LayerFlagButton
                        label={
                          row.hidden ? t("workspace:canvasMenuShow") : t("workspace:canvasMenuHide")
                        }
                        active={row.hidden}
                        shortcut={canvasShortcutLabelFor({ id: "toggle-hidden" })}
                        onClick={() => void flagRow(row, LAYER_HIDDEN_ATTRIBUTE, !row.hidden)}
                      >
                        {row.hidden ? (
                          <CentralIcon name="eye-closed" className="size-3" />
                        ) : (
                          <EyeOpenIcon className="size-3" />
                        )}
                      </LayerFlagButton>
                    </>
                  ) : null
                }
                onClick={(event) => pick(row, event)}
                onDoubleClick={() => {
                  if (writable && !lockedHere) setRenaming(row.key);
                }}
                onMouseEnter={() => setPanelHover(row.item)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!pickable(row)) return;
                  // Right-click selects the row unless it is already selected; the
                  // menu opens on the editor that selection renders.
                  if (!isSelected) select([row.item]);
                  const position = { x: event.clientX, y: event.clientY };
                  requestAnimationFrame(() => {
                    void showCanvasContextMenu({
                      commands,
                      t,
                      position,
                      onRename: (item) => setRenaming(selectionKey(item)),
                      onPaste: (mode) =>
                        void readClipboard().then((content) => {
                          const current = commands.editor();
                          const frame = current.frame(row.item.frameId);
                          if (!content || !frame) return;
                          return pasteIntoCanvas(
                            current,
                            commands,
                            content,
                            { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
                            mode,
                          );
                        }),
                    });
                  });
                }}
                onDragStart={(event) => {
                  setDragging(row.key);
                  motion.current = null;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/x-synara-layer", row.key);
                  setTreeRowDragImage(event);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDrop(null);
                }}
                onDragOver={(event) => onDragOver(event, at)}
                onDrop={(event) => {
                  event.preventDefault();
                  const sources = dragging ? draggedRows(dragging) : [];
                  setDragging(null);
                  setDrop(null);
                  if (sources.length && drop) void commitDrop(sources, drop);
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

/** Lock or eye toggle: shown while the row is hovered or focused, and always while it is on. */
function LayerFlagButton({
  label,
  active,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  /** The key that flags the selection the same way, shown in the tooltip. */
  shortcut: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton
      label={label}
      tooltip={<ShortcutTooltip label={label} shortcut={shortcut} />}
      aria-pressed={active}
      // Set flags stay visible; the others show while the row is hovered or focused.
      className={active ? undefined : TREE_ROW_REVEAL_CLASS_NAME}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </IconButton>
  );
}
