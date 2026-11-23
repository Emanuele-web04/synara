// FILE: useComposerSingleRow.ts
// Purpose: Decides whether a started thread's composer renders as one pill row
// (+ / editor / mic / send) or the full block.
// A newline, or a draft line wider than the row's editor slot, expands it to the block;
// it collapses back once the line fits that slot again. The slot width is recorded while
// the row shows, so the block never collapses into a row that would wrap at once.
// Layer: Chat composer layout
// Exports: useComposerSingleRow

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const EDITOR_SELECTOR = '[data-testid="composer-editor"]';
const SURFACE_SELECTOR = "[data-chat-composer-surface]";
/** Share of the surface assumed to be row chrome before the row has ever been measured. */
const UNMEASURED_ROW_CHROME_SHARE = 0.5;
/** A line must clear the slot by this much to fit. Both layouts compare against the same
 *  slot, so a line within it of the edge never flips row ↔ block on every render. */
const SLOT_FIT_MARGIN_PX = 2;

const cachedLineHeightByEditor = new WeakMap<HTMLElement, number>();

/** Natural width of the draft's only line, or Infinity once it spans more than one. */
function measureDraftLineWidth(editor: HTMLElement): number {
  const childCount = editor.children.length;
  if (childCount > 1) return Number.POSITIVE_INFINITY;
  const line = editor.children[0];
  if (!line) return 0;
  // Selecting the paragraph's contents (not the paragraph) measures the inline text and
  // chips, not the block box that always spans the editor's full width.
  const range = document.createRange();
  range.selectNodeContents(line);
  const rect = range.getBoundingClientRect();
  let lineHeight = cachedLineHeightByEditor.get(editor);
  if (lineHeight === undefined) {
    const parsed = Number.parseFloat(getComputedStyle(editor).lineHeight);
    lineHeight = Number.isFinite(parsed) ? parsed : Number.NaN;
    cachedLineHeightByEditor.set(editor, lineHeight);
  }
  if (Number.isFinite(lineHeight) && rect.height > lineHeight * 1.5) {
    return Number.POSITIVE_INFINITY;
  }
  return rect.width;
}

export function useComposerSingleRow(input: {
  formRef: RefObject<HTMLFormElement | null>;
  eligible: boolean;
  prompt: string;
}): boolean {
  const { formRef, eligible, prompt } = input;
  const [fits, setFits] = useState(true);
  const singleRow = eligible && fits;
  // Surface width minus editor width while the row shows: the controls beside the slot.
  const rowChromeWidthRef = useRef<number | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const singleRowRef = useRef(singleRow);
  singleRowRef.current = singleRow;
  const syncRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (!eligible) {
      syncRef.current = null;
      return;
    }
    const editor = formRef.current?.querySelector<HTMLElement>(EDITOR_SELECTOR);
    const surface = editor?.closest<HTMLElement>(SURFACE_SELECTOR);
    if (!editor || !surface) {
      syncRef.current = null;
      return;
    }
    const sync = () => {
      const currentPrompt = promptRef.current;
      if (currentPrompt.includes("\n")) {
        setFits(false);
        return;
      }
      // Fractional widths: rounded clientWidth would leave a sub-pixel band where the row
      // wraps while the block measures the same line as fitting.
      const surfaceWidth = surface.getBoundingClientRect().width;
      const editorWidth = editor.getBoundingClientRect().width;
      // Dictation and hidden panes have no measurable editor slot. Preserve the last
      // visible layout until ResizeObserver sees the editor again.
      if (surfaceWidth <= 0 || editorWidth <= 0) return;
      if (singleRowRef.current) {
        rowChromeWidthRef.current = surfaceWidth - editorWidth;
      }
      if (currentPrompt.length === 0) {
        setFits(true);
        return;
      }
      const rowChromeWidth =
        rowChromeWidthRef.current ?? surfaceWidth * UNMEASURED_ROW_CHROME_SHARE;
      const slotWidth = surfaceWidth - rowChromeWidth;
      setFits(measureDraftLineWidth(editor) <= slotWidth - SLOT_FIT_MARGIN_PX);
    };
    syncRef.current = sync;
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      cachedLineHeightByEditor.delete(editor);
      sync();
    });
    observer.observe(editor);
    observer.observe(surface);
    return () => {
      observer.disconnect();
      if (syncRef.current === sync) {
        syncRef.current = null;
      }
    };
  }, [eligible, formRef]);

  useLayoutEffect(() => {
    if (!eligible) return;
    syncRef.current?.();
  }, [eligible, prompt, singleRow]);

  return singleRow;
}
