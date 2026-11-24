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

const cachedLineHeightByElement = new WeakMap<HTMLElement, number>();

/** Natural width of a line's inline content, or Infinity once it wraps. */
function measureLineWidth(line: Element, lineHeightSource: HTMLElement): number {
  // Selecting the contents (not the block) measures the inline text and chips, not the
  // block box that always spans the editor's full width.
  const range = document.createRange();
  range.selectNodeContents(line);
  const rect = range.getBoundingClientRect();
  let lineHeight = cachedLineHeightByElement.get(lineHeightSource);
  if (lineHeight === undefined) {
    const parsed = Number.parseFloat(getComputedStyle(lineHeightSource).lineHeight);
    lineHeight = Number.isFinite(parsed) ? parsed : Number.NaN;
    cachedLineHeightByElement.set(lineHeightSource, lineHeight);
  }
  if (Number.isFinite(lineHeight) && rect.height > lineHeight * 1.5) {
    return Number.POSITIVE_INFINITY;
  }
  return rect.width;
}

/** Natural width of the draft's only line, or Infinity once it spans more than one. */
function measureDraftLineWidth(editor: HTMLElement): number {
  if (editor.children.length > 1) return Number.POSITIVE_INFINITY;
  const line = editor.children[0];
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
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const predictionRef = useRef(prediction);
  predictionRef.current = prediction;
  const singleRowRef = useRef(singleRow);
  singleRowRef.current = singleRow;
  // The editor and surface currently measured, with the observer watching them.
  const attachmentRef = useRef<{
    readonly form: HTMLFormElement;
    readonly editor: HTMLElement;
    readonly surface: HTMLElement;
    readonly observer: ResizeObserver | null;
    readonly sync: () => void;
  } | null>(null);

  // Runs after every commit, because the composer form can mount after this hook's
  // host (the pane content renders late) or be replaced without any measured input
  // changing. The steady state is an identity check; the DOM is only queried, and the
  // observer only rebuilt, when the form or its editor actually changed.
  useLayoutEffect(() => {
    const attached = attachmentRef.current;
    const form = eligible ? formRef.current : null;
    if (
      attached !== null &&
      attached.form === form &&
      attached.editor.isConnected &&
      attached.surface.isConnected
    ) {
      return;
    }
    attached?.observer?.disconnect();
    attachmentRef.current = null;
    const editor = form?.querySelector<HTMLElement>(EDITOR_SELECTOR);
    const surface = editor?.closest<HTMLElement>(SURFACE_SELECTOR);
    if (!form || !editor || !surface) return;
    const sync = () => {
      const currentPrompt = promptRef.current;
      const currentPrediction = predictionRef.current;
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
      if (currentPrompt.length === 0 && !currentPrediction) {
        setFits(true);
        return;
      }
      const rowChromeWidth =
        rowChromeWidthRef.current ?? surfaceWidth * UNMEASURED_ROW_CHROME_SHARE;
      const slotWidth = surfaceWidth - rowChromeWidth;
      // The ghost is drawn only while the editor is empty. That includes the moment an
      // accepted suggestion's draft is committed but not yet in the editor, so measure it
      // whenever it is there rather than only while the prompt is empty.
      const ghost = currentPrediction
        ? surface.querySelector<HTMLElement>(PREDICTION_LINE_SELECTOR)
        : null;
      const lineWidth = ghost ? measureLineWidth(ghost, ghost) : measureDraftLineWidth(editor);
      setFits(lineWidth <= slotWidth - SLOT_FIT_MARGIN_PX);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cachedLineHeightByElement.delete(editor);
            const ghost = predictionRef.current
              ? surface.querySelector<HTMLElement>(PREDICTION_LINE_SELECTOR)
              : null;
            if (ghost) cachedLineHeightByElement.delete(ghost);
            sync();
          });
    observer?.observe(editor);
    observer?.observe(surface);
    attachmentRef.current = { form, editor, surface, observer, sync };
    sync();
  });

  // Re-measure when the draft, the suggestion or the layout changes; the observer
  // above covers size changes that happen without any of them changing.
  useLayoutEffect(() => {
    if (!eligible) return;
    attachmentRef.current?.sync();
  }, [eligible, prediction, prompt, singleRow]);

  useLayoutEffect(
    () => () => {
      attachmentRef.current?.observer?.disconnect();
      attachmentRef.current = null;
    },
    [],
  );

  return singleRow;
}
