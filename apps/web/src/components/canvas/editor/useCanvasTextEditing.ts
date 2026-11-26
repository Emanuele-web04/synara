// FILE: useCanvasTextEditing.ts
// Purpose: In-place text editing on the canvas: a text block (plain text, or text with styled
//          ranges) becomes `plaintext-only` editable with everything selected (or a caret where
//          the Text tool clicked), Enter (or Esc, ⌘Enter, a blur, a click away) saves it,
//          Shift+Enter is a newline, Tab and ⇧Tab move to the next or previous text layer, and
//          ⌘B / ⌘I / ⌘U style the selection (`canvasTextEdit.ts`). One edit session saves
//          exactly once, however many of those end it, typing and styling as one step; a layer
//          left empty is deleted in that same step. Focus moving to the inspector keeps the
//          edit open, so the inspector can style the selected range.
// Layer: Canvas editor input
// Exports: useCanvasTextEditing, textEditOperations, nextTextLayer, CanvasTextEditing

import type { CanvasWork, DesignFrame, DesignLayerEdit } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isMacPlatform } from "~/lib/utils";
import { selectionKey } from "../canvasStores";
import { useCanvasEditor } from "./CanvasEditorContext";
import { createTextEdit, type TextEdit, type TextFormat } from "./canvasTextEdit";
import { canvasTextSession } from "./canvasTextSession";
import {
  indexLayers,
  isLayerHidden,
  isLayerLocked,
  isTextOnly,
  preorderLayers,
  type LayerIndex,
  type LayerItem,
} from "./canvasSelection";

/**
 * What saving `text` into a text layer sends: nothing when it did not change, a delete when it
 * was emptied (an empty text layer goes in the same undo step), and `white-space:
 * pre-wrap` alongside text with line breaks when the layer would collapse them.
 */
export function textEditOperations(
  index: LayerIndex,
  layerId: string,
  text: string,
  options: { collapsesNewlines?: boolean } = {},
): DesignLayerEdit[] | null {
  const node = index.nodes.get(layerId);
  if (node?.type !== "element") return null;
  const textChildren = node.children.filter((id) => index.nodes.get(id)?.type === "text");
  const current = textChildren.map((id) => {
    const child = index.nodes.get(id);
    return child?.type === "text" ? child.text : "";
  });
  if (current.join("") === text) return null;
  if (text.trim() === "") return [{ type: "delete", nodeId: layerId }];
  const wrap: DesignLayerEdit[] =
    options.collapsesNewlines && text.includes("\n")
      ? [{ type: "set_styles", nodeId: layerId, styles: { "white-space": "pre-wrap" } }]
      : [];
  if (textChildren.length === 0)
    return [
      {
        type: "insert_html",
        parentId: layerId,
        html: text.replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
      },
      ...wrap,
    ];
  return [
    { type: "set_text", nodeId: textChildren[0]!, text },
    ...textChildren.slice(1).map((id): DesignLayerEdit => ({ type: "delete", nodeId: id })),
    ...wrap,
  ];
}

/**
 * Tab / ⇧Tab while editing: the next or previous editable text layer
 * in tree order across the page's frames, wrapping around.
 */
export function nextTextLayer(
  frames: readonly Pick<DesignFrame, "id" | "layers">[],
  index: (frameId: string) => LayerIndex | undefined,
  current: LayerItem,
  step: 1 | -1,
): LayerItem | null {
  const order: LayerItem[] = [];
  for (const frame of frames) {
    const layers = index(frame.id);
    if (!layers) continue;
    for (const layerId of preorderLayers(layers, frame.layers.roots))
      if (
        isTextOnly(layers, layerId) &&
        !isLayerLocked(layers, layerId) &&
        !isLayerHidden(layers, layerId)
      )
        order.push({ kind: "layer", frameId: frame.id, layerId });
  }
  const at = order.findIndex((item) => selectionKey(item) === selectionKey(current));
  if (order.length < 2 && at >= 0) return null;
  return order[(at + step + order.length) % order.length] ?? null;
}

type Session = {
  item: LayerItem;
  element: HTMLElement | null;
  /** The edit's styling, history and save, once the element is being typed into. */
  edit: TextEdit | null;
  done: boolean;
  detach: (() => void) | null;
  /** Where the Text tool clicked: the caret goes there instead of selecting everything. */
  caret: { x: number; y: number } | null;
  /** The Text tool just created this layer (and `ownFrame`: the frame around it). */
  created: boolean;
  ownFrame: boolean;
  settled: Promise<void>;
  settle: () => void;
};

export type CanvasTextEditing = {
  /**
   * Starts editing a text layer. Right after creating one, pass the saved `work`: the editor
   * has not rendered the new layer yet, and editing begins as soon as it has. `created` marks
   * a layer the Text tool just made: left empty, it is removed (with `ownFrame`, its frame
   * too) and the creation leaves no undo step.
   */
  start: (
    item: LayerItem,
    options?: {
      work?: CanvasWork;
      caret?: { x: number; y: number };
      created?: boolean;
      ownFrame?: boolean;
    },
  ) => boolean;
  /** Ends the edit and saves what was typed, once. */
  commit: (options?: { cancel?: boolean }) => Promise<void>;
  /** Resolves once the current edit has ended and been saved (at once when none is open). */
  settled: () => Promise<void>;
  /** Whether a pointer event's path runs through the layer being edited. */
  owns: (path: readonly EventTarget[]) => boolean;
};

const FORMAT_KEYS: Readonly<Record<string, TextFormat>> = {
  b: "bold",
  i: "italic",
  u: "underline",
};
const FORMAT_CODES: Readonly<Record<string, TextFormat>> = {
  KeyB: "bold",
  KeyI: "italic",
  KeyU: "underline",
};
const isMac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

/** The format a ⌘B / ⌘I / ⌘U press toggles in a text edit, or null for any other key. */
function formatChord(event: KeyboardEvent, mac = isMac): TextFormat | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return null;
  // ⌘⇧X strikes the text through.
  if (event.shiftKey) return event.code === "KeyX" ? "strikethrough" : null;
  return FORMAT_KEYS[event.key.toLowerCase()] ?? FORMAT_CODES[event.code] ?? null;
}

/**
 * The chords a text edit handles itself: ⌘B / ⌘I / ⌘U / ⌘⇧X and its own undo and redo. The canvas
 * claims them from the app's shortcuts while an edit is open (see `claimShortcuts`).
 */
export function isCanvasTextEditChord(event: KeyboardEvent, mac = isMac): boolean {
  if (formatChord(event, mac)) return true;
  const mod = mac ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  return mod && !event.altKey && (key === "z" || key === "y");
}

/** The caret at a client point inside `element`, or null when the point misses its text. */
function caretRangeAt(element: HTMLElement, x: number, y: number): Range | null {
  const shadow = element.getRootNode();
  const at = (
    document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
        options?: { shadowRoots?: ShadowRoot[] },
      ) => { offsetNode: Node; offset: number } | null;
    }
  ).caretPositionFromPoint?.(x, y, shadow instanceof ShadowRoot ? { shadowRoots: [shadow] } : {});
  if (!at || !element.contains(at.offsetNode)) return null;
  const range = document.createRange();
  range.setStart(at.offsetNode, at.offset);
  range.collapse(true);
  return range;
}

export function useCanvasTextEditing(): CanvasTextEditing {
  const { editingText, domVersion, commands } = useCanvasEditor();
  const session = useRef<Session | null>(null);

  const commit = useCallback<CanvasTextEditing["commit"]>(
    async ({ cancel = false } = {}) => {
      const current = session.current;
      if (!current || current.done) return;
      current.done = true;
      current.detach?.();
      if (current.edit) canvasTextSession.clear(current.edit.session);
      const editor = commands.editor();
      const found = current.element ?? editor.elementFor(current.item);
      // Only HTML layers hold editable text (an inline SVG is never text-only).
      const element = found instanceof HTMLElement ? found : null;
      editor.setEditingText(null);
      try {
        if (!element) return;
        element.removeAttribute("contenteditable");
        element.removeAttribute("data-synara-editing");
        const index = editor.layers(current.item.frameId);
        const plain = (typed: string, collapsesNewlines: boolean) =>
          index
            ? textEditOperations(index, current.item.layerId, typed, { collapsesNewlines })
            : null;
        const whiteSpace = getComputedStyle(element).whiteSpace;
        const operations =
          cancel || !index
            ? null
            : current.edit
              ? current.edit.operations(plain)
              : plain(
                  element.innerText.replace(/\n$/, ""),
                  whiteSpace === "normal" || whiteSpace === "nowrap",
                );
        if (!operations) return editor.bumpDom();
        const { frameId, layerId } = current.item;
        if (current.created && operations[0]?.type === "delete") {
          // Created and left empty: it goes again, and so does its undo step.
          if (current.ownFrame)
            await editor.run(
              { kind: "layout", frames: [{ id: frameId, remove: true }] },
              { record: false },
            );
          else
            await editor.run(
              { kind: "edit", frameId, operations: [{ type: "delete", nodeId: layerId }] },
              { record: false },
            );
          editor.discardBatch();
          editor.select([], { record: false });
          return;
        }
        await editor.run({ kind: "edit", frameId, operations });
        if (operations[0]?.type === "delete") editor.select([], { record: false });
      } finally {
        current.settle();
      }
    },
    [commands],
  );

  const start = useCallback<CanvasTextEditing["start"]>(
    (item, { work, caret, created = false, ownFrame = false } = {}) => {
      const editor = commands.editor();
      if (editor.readOnly) return false;
      const frame = work?.pages
        .find((page) => page.id === editor.page.id)
        ?.frames.find((candidate) => candidate.id === item.frameId);
      const index = frame ? indexLayers(frame.layers) : editor.layers(item.frameId);
      if (!index || !isTextOnly(index, item.layerId) || isLayerLocked(index, item.layerId))
        return false;
      if (session.current && !session.current.done) void commit();
      let settle = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      session.current = {
        item,
        element: null,
        edit: null,
        done: false,
        detach: null,
        caret: caret ?? null,
        created,
        ownFrame,
        settled,
        settle,
      };
      editor.select([item]);
      editor.setEditingText(item);
      return true;
    },
    [commands, commit],
  );

  // Editing begins once the layer is rendered: for a layer just created, after the editor has
  // rendered the saved work.
  useEffect(() => {
    const current = session.current;
    if (!current || current.done || current.element) return;
    if (!editingText || selectionKey(editingText) !== selectionKey(current.item)) return;
    const element = commands.editor().elementFor(editingText);
    if (!(element instanceof HTMLElement)) return;
    current.element = element;
    element.setAttribute("data-synara-editing", "");
    element.setAttribute("contenteditable", "plaintext-only");
    element.focus({ preventScroll: true });
    const caret = current.caret ? caretRangeAt(element, current.caret.x, current.caret.y) : null;
    const range = caret ?? document.createRange();
    if (!caret) range.selectNodeContents(element);
    const selectionApi = document.getSelection();
    selectionApi?.removeAllRanges();
    selectionApi?.addRange(range);
    const edit = createTextEdit({
      item: current.item,
      element,
      editor: () => commands.editor(),
      changed: () => canvasTextSession.changed(edit.session),
    });
    current.edit = edit;
    canvasTextSession.set(edit.session);
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      // An IME composing text owns its keys, Enter included.
      if (event.isComposing || event.keyCode === 229) return;
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (mod && !event.altKey) {
        const format = formatChord(event);
        if (format) {
          event.preventDefault();
          edit.toggle(format);
          return;
        }
        const key = event.key.toLowerCase();
        if (
          (key === "z" || key === "y") &&
          edit.history(key === "y" || event.shiftKey ? "redo" : "undo")
        ) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const editor = commands.editor();
        const next = nextTextLayer(
          editor.page.frames,
          editor.layers,
          current.item,
          event.shiftKey ? -1 : 1,
        );
        void commit();
        if (next) start(next);
        return;
      }
      const enter = event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey);
      if (event.key === "Escape" || enter) {
        event.preventDefault();
        void commit();
      }
    };
    // A press elsewhere ends an edit the inspector holds open; the inspector's own do not.
    const onOutsidePress = (event: PointerEvent) => {
      if (canvasTextSession.isInspectorPress(event) || event.composedPath().includes(element))
        return;
      void commit();
    };
    const onBlur = (event: FocusEvent) => {
      if (canvasTextSession.isInspectorFocus(event.relatedTarget)) {
        edit.hold();
        document.addEventListener("pointerdown", onOutsidePress);
        return;
      }
      void commit();
    };
    const onFocus = () => edit.release();
    const onBeforeInput = (event: InputEvent) => edit.beforeInput(event);
    const onInput = () => edit.input();
    const onPaste = (event: ClipboardEvent) => {
      // Plain text only: foreign markup never reaches the layer.
      event.preventDefault();
      event.stopPropagation();
      edit.paste(event.clipboardData?.getData("text/plain") ?? "");
    };
    const onSelection = () => edit.selectionChanged();
    element.addEventListener("keydown", onKey);
    element.addEventListener("blur", onBlur);
    element.addEventListener("focus", onFocus);
    element.addEventListener("beforeinput", onBeforeInput);
    element.addEventListener("input", onInput);
    element.addEventListener("paste", onPaste);
    document.addEventListener("selectionchange", onSelection);
    current.detach = () => {
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("blur", onBlur);
      element.removeEventListener("focus", onFocus);
      element.removeEventListener("beforeinput", onBeforeInput);
      element.removeEventListener("input", onInput);
      element.removeEventListener("paste", onPaste);
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("pointerdown", onOutsidePress);
      edit.release();
    };
  }, [commands, commit, domVersion, editingText, start]);

  // The editor ended editing on its own (a page switch): nothing is saved.
  useEffect(() => {
    const current = session.current;
    if (!current || current.done) return;
    if (editingText && selectionKey(editingText) === selectionKey(current.item)) return;
    current.done = true;
    current.detach?.();
    if (current.edit) canvasTextSession.clear(current.edit.session);
    current.settle();
  }, [editingText]);
  useEffect(
    () => () => {
      session.current?.detach?.();
      if (session.current?.edit) canvasTextSession.clear(session.current.edit.session);
      session.current?.settle();
    },
    [],
  );

  return useMemo(
    () => ({
      start,
      commit,
      settled: () => session.current?.settled ?? Promise.resolve(),
      owns: (path) => {
        const element = session.current?.done === false ? session.current.element : null;
        return element !== null && path.includes(element);
      },
    }),
    [commit, start],
  );
}
