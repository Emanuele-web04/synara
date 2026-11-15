// FILE: useComposerSingleRow.ts
// Purpose: Decides whether a started thread's composer renders as one pill row
// (+ / editor / mic / send) or the full block.
// A newline, or a draft line wider than the row's editor slot, expands it to the block;
// it collapses back once the line fits that slot again. The slot width is recorded while
// the row shows, so the block never collapses into a row that would wrap at once. An empty
// draft showing a composer prediction is measured by its ghost text and chip instead, so a
// suggestion that would wrap gets the block's room the same way a long draft does.
// Layer: Chat composer layout
// Exports: useComposerSingleRow

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const EDITOR_SELECTOR = '[data-testid="composer-editor"]';
const PREDICTION_LINE_SELECTOR = '[data-testid="composer-prediction"] [data-prediction-line]';
const SURFACE_SELECTOR = "[data-chat-composer-surface]";
/** Share of the surface assumed to be row chrome before the row has ever been measured. */
const UNMEASURED_ROW_CHROME_SHARE = 0.5;
/** A line must clear the slot by this much to fit. Both layouts compare against the same
 *  slot, so a line within it of the edge never flips row ↔ block on every render. */
const SLOT_FIT_MARGIN_PX = 2;

/** Natural width of a line's inline content, or Infinity once it wraps. */
function measureLineWidth(line: Element, lineHeightSource: HTMLElement): number {
  // Selecting the contents (not the block) measures the inline text and chips, not the
  // block box that always spans the editor's full width.
  const range = document.createRange();
  range.selectNodeContents(line);
  const rect = range.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(lineHeightSource).lineHeight);
  if (Number.isFinite(lineHeight) && rect.height > lineHeight * 1.5) {
    return Number.POSITIVE_INFINITY;
  }
  return rect.width;
}

/** Natural width of the draft's only line, or Infinity once it spans more than one. */
function measureDraftLineWidth(editor: HTMLElement): number {
  const [line, ...rest] = Array.from(editor.children);
  if (rest.length > 0) return Number.POSITIVE_INFINITY;
  if (!line) return 0;
  return measureLineWidth(line, editor);
}

export function useComposerSingleRow(input: {
  formRef: RefObject<HTMLFormElement | null>;
  eligible: boolean;
  prompt: string;
  /** The composer prediction drawn as ghost text, which the empty editor is measured by. */
  prediction?: string | null | undefined;
}): boolean {
  const { formRef, eligible, prompt, prediction = null } = input;
  const [fits, setFits] = useState(true);
  const singleRow = eligible && fits;
  // Surface width minus editor width while the row shows: the controls beside the slot.
  const rowChromeWidthRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!eligible) return;
    const editor = formRef.current?.querySelector<HTMLElement>(EDITOR_SELECTOR);
    const surface = editor?.closest<HTMLElement>(SURFACE_SELECTOR);
    if (!editor || !surface) return;
    const sync = () => {
      // Fractional widths: rounded clientWidth would leave a sub-pixel band where the row
      // wraps while the block measures the same line as fitting.
      const surfaceWidth = surface.getBoundingClientRect().width;
      const editorWidth = editor.getBoundingClientRect().width;
      // Dictation and hidden panes have no measurable editor slot. Preserve the last
      // visible layout until ResizeObserver sees the editor again.
      if (surfaceWidth <= 0 || editorWidth <= 0) return;
      if (singleRow) {
        rowChromeWidthRef.current = surfaceWidth - editorWidth;
      }
      const rowChromeWidth =
        rowChromeWidthRef.current ?? surfaceWidth * UNMEASURED_ROW_CHROME_SHARE;
      const slotWidth = surfaceWidth - rowChromeWidth;
      // The ghost is drawn only while the editor is empty. That includes the moment an
      // accepted suggestion's draft is committed but not yet in the editor, so measure it
      // whenever it is there rather than only while the prompt is empty.
      const ghost = prediction
        ? surface.querySelector<HTMLElement>(PREDICTION_LINE_SELECTOR)
        : null;
      const lineWidth = ghost ? measureLineWidth(ghost, ghost) : measureDraftLineWidth(editor);
      setFits(!prompt.includes("\n") && lineWidth <= slotWidth - SLOT_FIT_MARGIN_PX);
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(editor);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [eligible, formRef, prediction, prompt, singleRow]);

  return singleRow;
}
