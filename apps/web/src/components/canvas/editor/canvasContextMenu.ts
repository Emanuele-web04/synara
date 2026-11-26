import type { ContextMenuItem } from "@synara/contracts";
import type { t as translate } from "~/i18n";
import { contextMenuGroup } from "~/lib/contextMenuGroup";
import { ensureNativeApi } from "~/nativeApi";
import type { CanvasSelectionItem } from "../canvasStores";
import type { CanvasPasteMode } from "./canvasClipboard";
import type { CanvasCommands } from "./canvasCommands";
import type { CanvasTextAlign, CanvasTextFormat } from "./canvasShortcuts";
import { showCanvasToast } from "./canvasToasts";
import { makeCanvasExportActions } from "./canvasSelectionExport";
import {
  isLayerItem,
  isLayerLocked,
  LAYER_HIDDEN_ATTRIBUTE,
  LAYER_LOCKED_ATTRIBUTE,
  layerLabel,
} from "./canvasSelection";

/** A "Select layer…" entry: `select-layer:<layer id>`. */
type SelectLayerAction = `select-layer:${string}`;
type Action =
  | SelectLayerAction
  | "rename"
  | "copy"
  | "paste"
  | "paste-on-top"
  | "paste-replace"
  | "remove-flex"
  | "duplicate"
  | "delete"
  | "copy-png"
  | "copy-tailwind"
  | "copy-react"
  | "copy-styles"
  | "paste-styles"
  | "select-parent"
  | "select-children"
  | "front"
  | "forward"
  | "backward"
  | "back"
  | "wrap"
  | "ungroup"
  | "flex"
  | "hide"
  | "lock"
  | "export"
  | "cover"
  | "deselect"
  | "text-bold"
  | "text-italic"
  | "text-underline"
  | "text-strikethrough"
  | "text-left"
  | "text-center"
  | "text-right"
  | "text-justify";

/** The "Adjust text" rows and what each runs. */
const TEXT_ACTIONS = {
  "text-bold": ["workspace:canvasShortcutBold", { format: "bold" }],
  "text-italic": ["workspace:canvasShortcutItalic", { format: "italic" }],
  "text-underline": ["workspace:canvasShortcutUnderline", { format: "underline" }],
  "text-strikethrough": ["workspace:canvasShortcutStrikethrough", { format: "strikethrough" }],
  "text-left": ["workspace:canvasShortcutTextLeft", { align: "left" }],
  "text-center": ["workspace:canvasShortcutTextCenter", { align: "center" }],
  "text-right": ["workspace:canvasShortcutTextRight", { align: "right" }],
  "text-justify": ["workspace:canvasShortcutTextJustify", { align: "justify" }],
} as const satisfies Record<
  string,
  readonly [string, { format: CanvasTextFormat } | { align: CanvasTextAlign }]
>;
type TextAction = keyof typeof TEXT_ACTIONS;
const isTextAction = (action: string | null): action is TextAction =>
  action !== null && action in TEXT_ACTIONS;

/** Right-click on empty canvas: paste, step through the frames, show or hide the UI. */
export async function showCanvasEmptyMenu(input: {
  t: typeof translate;
  position: { x: number; y: number };
  readOnly: boolean;
  hasFrames: boolean;
  uiHidden: boolean;
  onPaste: () => void;
  onFrameStep: (step: 1 | -1) => void;
  onToggleUi: () => void;
}) {
  const { t } = input;
  type EmptyAction = "paste" | "next-frame" | "previous-frame" | "toggle-ui";
  const items: ContextMenuItem<EmptyAction>[] = [
    ...(input.readOnly ? [] : [{ id: "paste" as const, label: t("workspace:canvasMenuPaste") }]),
    ...(input.hasFrames
      ? contextMenuGroup<EmptyAction>(
          { id: "next-frame", label: t("workspace:canvasMenuGoToFrame") },
          [
            { id: "next-frame", label: t("workspace:canvasShortcutNextFrame") },
            { id: "previous-frame", label: t("workspace:canvasShortcutPreviousFrame") },
          ],
        )
      : []),
    {
      id: "toggle-ui",
      label: input.uiHidden ? t("workspace:canvasMenuShowUi") : t("workspace:canvasMenuHideUi"),
      separatorBefore: !input.readOnly || input.hasFrames,
    },
  ];
  const clicked = await ensureNativeApi().contextMenu.show(items, input.position);
  if (clicked === "paste") input.onPaste();
  else if (clicked === "next-frame") input.onFrameStep(1);
  else if (clicked === "previous-frame") input.onFrameStep(-1);
  else if (clicked === "toggle-ui") input.onToggleUi();
}

/**
 * The layer menu, shared by the canvas and the layers panel. Variants of one action share a
 * parent row (copy as, styles, select, arrange), as the repository's menu rule requires. It
 * reads the editor when it opens, so a right-click that just changed the selection acts on it.
 */
export async function showCanvasContextMenu(input: {
  commands: CanvasCommands;
  t: typeof translate;
  position: { x: number; y: number };
  onPaste?: ((mode: CanvasPasteMode) => void) | undefined;
  /** Every layer under the pointer, deepest last (the canvas's "Select layer…"). */
  layersAt?: { frameId: string; layerIds: readonly string[] } | null | undefined;
  /** Inline rename of the row or frame label. */
  onRename?: ((item: CanvasSelectionItem) => void) | undefined;
}) {
  const { commands, t } = input;
  const editor = commands.editor();
  const selection = editor.selection;
  if (selection.length === 0) return;
  const layers = selection.filter(isLayerItem);
  const writable = !editor.readOnly;
  const flagged = commands.isFlagged;
  // "Select layer…": the layers under the pointer, deepest first, locked ones left out.
  const under = input.layersAt;
  const underIndex = under ? editor.layers(under.frameId) : undefined;
  const pickable =
    under && underIndex
      ? under.layerIds.filter((id) => !isLayerLocked(underIndex, id)).toReversed()
      : [];
  const flexed = selection.some((item) => {
    const element = editor.elementFor(item);
    return element !== null && getComputedStyle(element).display.includes("flex");
  });
  const items: ContextMenuItem<Action>[] = [
    ...(pickable.length > 1 && underIndex
      ? [
          {
            id: `select-layer:${pickable[0]!}` as const,
            label: t("workspace:canvasMenuSelectLayer"),
            children: pickable.map((id) => ({
              id: `select-layer:${id}` as const,
              label: layerLabel(underIndex, id),
            })),
          },
        ]
      : []),
    ...(writable && selection.length === 1 && input.onRename
      ? [{ id: "rename" as const, label: t("workspace:canvasMenuRename") }]
      : []),
    { id: "copy", label: t("workspace:canvasMenuCopy"), separatorBefore: pickable.length > 1 },
    // Paste, Paste on top and Paste to replace share one row.
    ...(writable && input.onPaste
      ? contextMenuGroup<Action>({ id: "paste", label: t("workspace:canvasMenuPaste") }, [
          { id: "paste", label: t("workspace:canvasMenuPaste") },
          { id: "paste-on-top", label: t("workspace:canvasMenuPasteOnTop") },
          { id: "paste-replace", label: t("workspace:canvasMenuPasteReplace") },
        ])
      : []),
    ...(writable ? [{ id: "duplicate" as const, label: t("workspace:canvasMenuDuplicate") }] : []),
    // One node gets a "Copy as" submenu; several only copy as PNG.
    ...(selection.length === 1
      ? contextMenuGroup<Action>(
          { id: "copy-png", label: t("workspace:canvasMenuCopyAs"), separatorBefore: true },
          [
            { id: "copy-png", label: t("workspace:canvasMenuCopyPng") },
            {
              id: "copy-tailwind",
              label: t("workspace:canvasMenuCopyTailwind"),
              separatorBefore: true,
            },
            { id: "copy-react", label: t("workspace:canvasMenuCopyReact") },
          ],
        )
      : [{ id: "copy-png" as const, label: t("workspace:canvasCopyPng"), separatorBefore: true }]),
    ...contextMenuGroup<Action>({ id: "copy-styles", label: t("workspace:canvasMenuStyles") }, [
      { id: "copy-styles", label: t("workspace:canvasMenuCopyStyles") },
      ...(writable && commands.canPasteStyles()
        ? [{ id: "paste-styles" as const, label: t("workspace:canvasMenuPasteStyles") }]
        : []),
    ]),
    ...contextMenuGroup<Action>({ id: "select-parent", label: t("workspace:canvasMenuSelect") }, [
      ...(layers.length
        ? [{ id: "select-parent" as const, label: t("workspace:canvasMenuSelectParent") }]
        : []),
      { id: "select-children", label: t("workspace:canvasMenuSelectChildren") },
    ]),
    ...(writable && layers.length
      ? contextMenuGroup<Action>(
          { id: "front", label: t("workspace:canvasMenuArrange"), separatorBefore: true },
          [
            { id: "front", label: t("workspace:canvasMenuBringToFront") },
            { id: "forward", label: t("workspace:canvasMenuBringForward") },
            { id: "backward", label: t("workspace:canvasMenuSendBackward") },
            { id: "back", label: t("workspace:canvasMenuSendToBack") },
          ],
        )
      : []),
    // Text layers (or text inside the selection) get the text keys' formats and alignments.
    ...(writable && commands.hasTextTargets()
      ? [
          {
            id: "text-bold" as const,
            label: t("workspace:canvasMenuAdjustText"),
            separatorBefore: true,
            children: (Object.keys(TEXT_ACTIONS) as TextAction[]).map((id) => ({
              id,
              label: t(TEXT_ACTIONS[id][0]),
              separatorBefore: id === "text-left",
            })),
          },
        ]
      : []),
    ...(writable && layers.length
      ? [
          { id: "wrap" as const, label: t("workspace:canvasMenuWrap") },
          { id: "ungroup" as const, label: t("workspace:canvasMenuUngroup") },
          flexed
            ? { id: "remove-flex" as const, label: t("workspace:canvasMenuRemoveFlex") }
            : { id: "flex" as const, label: t("workspace:canvasMenuAddFlex") },
          {
            id: "hide" as const,
            label: flagged(LAYER_HIDDEN_ATTRIBUTE)
              ? t("workspace:canvasMenuShow")
              : t("workspace:canvasMenuHide"),
            separatorBefore: true,
          },
          {
            id: "lock" as const,
            label: flagged(LAYER_LOCKED_ATTRIBUTE)
              ? t("workspace:canvasMenuUnlock")
              : t("workspace:canvasMenuLock"),
          },
        ]
      : []),
    { id: "export", label: t("workspace:canvasMenuExport"), separatorBefore: true },
    // The work's cover: one frame can be the work's library thumbnail.
    ...(writable && selection.length === 1 && selection[0]!.kind === "frame"
      ? [
          {
            id: "cover" as const,
            label: commands.isCover(selection[0]!.frameId)
              ? t("workspace:canvasMenuRemoveCover")
              : t("workspace:canvasMenuUseAsCover"),
          },
        ]
      : []),
    { id: "deselect", label: t("workspace:canvasMenuDeselect"), separatorBefore: true },
    ...(writable
      ? [
          {
            id: "delete" as const,
            label: t("workspace:canvasMenuDelete"),
            destructive: true,
            separatorBefore: true,
          },
        ]
      : []),
  ];
  const clicked = await ensureNativeApi().contextMenu.show(items, input.position);
  const exports = makeCanvasExportActions(editor, t);
  if (isTextAction(clicked)) {
    const action = TEXT_ACTIONS[clicked][1];
    return void ("format" in action
      ? commands.formatText(action.format)
      : commands.alignText(action.align));
  }
  if (clicked?.startsWith("select-layer:") && under) {
    const layerId = clicked.slice("select-layer:".length);
    return editor.select([{ kind: "layer", frameId: under.frameId, layerId }]);
  }
  switch (clicked) {
    case "rename":
      return input.onRename?.(selection[0]!);
    case "copy":
      return void commands.copy();
    case "paste":
      return input.onPaste?.("normal");
    case "paste-on-top":
      return input.onPaste?.("on-top");
    case "paste-replace":
      return input.onPaste?.("replace");
    case "remove-flex":
      return void commands.removeFlex();
    case "duplicate":
      return void commands.duplicate();
    case "delete":
      return void commands.remove();
    case "copy-png":
      return void exports.copyPng(selection);
    case "copy-tailwind":
      return void exports.copyCode(selection[0]!, "tailwind");
    case "copy-react":
      return void exports.copyCode(selection[0]!, "css");
    case "copy-styles":
      commands.copyStyles();
      return showCanvasToast(t("workspace:canvasToastStylesCopied"));
    case "paste-styles":
      return void commands
        .pasteStyles()
        .then(() => showCanvasToast(t("workspace:canvasToastStylesPasted")));
    case "select-parent":
      return commands.selectParent();
    case "select-children":
      return commands.selectChildren();
    case "front":
    case "forward":
    case "backward":
    case "back":
      return void commands.arrange(clicked);
    case "wrap":
      return void commands.wrap();
    case "ungroup":
      return void commands.ungroup();
    case "flex":
      return void commands.addFlex();
    case "hide":
      return void commands.toggleHidden();
    case "lock":
      return void commands.toggleLocked();
    case "export":
      return void exports.exportFiles(selection);
    case "deselect":
      return editor.select([]);
    case "cover": {
      const frameId = selection[0]!.frameId;
      return void commands.setCover(commands.isCover(frameId) ? null : frameId);
    }
    default:
      return;
  }
}
