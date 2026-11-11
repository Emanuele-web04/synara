import "../index.css";

import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

type EditorProps = ComponentProps<typeof ComposerPromptEditor>;

async function mountEditor(initial: Partial<EditorProps> = {}) {
  const ref = createRef<ComposerPromptEditorHandle>();
  let props: EditorProps = {
    value: "Original draft",
    cursor: 4,
    terminalContexts: [],
    disabled: false,
    placeholder: "Write a message",
    ariaLabel: "Message",
    onRemoveTerminalContext: vi.fn(),
    onChange: vi.fn(),
    onPaste: vi.fn(),
    ...initial,
  };
  const content = () => (
    <>
      <input aria-label="Another control" />
      <ComposerPromptEditor {...props} ref={ref} />
    </>
  );
  const screen = await render(content());
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  const otherControl = document.querySelector<HTMLInputElement>(
    'input[aria-label="Another control"]',
  )!;
  return {
    ref,
    editor,
    otherControl,
    update: async (updates: Partial<EditorProps>) => {
      props = { ...props, ...updates };
      await screen.rerender(content());
    },
  };
}

async function settleSelection() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function focusParentFrame() {
  expect(window.parent).not.toBe(window);
  const body = window.parent.document.body;
  const originalTabIndex = body.getAttribute("tabindex");
  body.tabIndex = -1;
  body.focus();
  return () => {
    if (originalTabIndex === null) body.removeAttribute("tabindex");
    else body.setAttribute("tabindex", originalTabIndex);
  };
}

describe("ComposerPromptEditor focus ownership", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("updates a controlled draft without taking focus from another control", async () => {
    const mounted = await mountEditor();
    mounted.otherControl.focus();
    mounted.otherControl.value = "Keep my selection";
    mounted.otherControl.setSelectionRange(2, 6);

    await mounted.update({ value: "Restored draft", cursor: 3 });
    await settleSelection();

    expect(mounted.editor.textContent).toBe("Restored draft");
    expect(document.activeElement).toBe(mounted.otherControl);
    expect(mounted.otherControl.selectionStart).toBe(2);
    expect(mounted.otherControl.selectionEnd).toBe(6);
    expect(mounted.ref.current?.readSnapshot()).toMatchObject({
      value: "Restored draft",
      cursor: 3,
    });
  });

  it("refreshes mention references without taking focus from another control", async () => {
    const mounted = await mountEditor();
    mounted.otherControl.focus();

    await mounted.update({
      mentionReferences: [{ name: "linear", path: "plugin://linear@openai-curated" }],
    });
    await settleSelection();

    expect(mounted.editor.textContent).toBe("Original draft");
    expect(document.activeElement).toBe(mounted.otherControl);
  });

  it("keeps a controlled update inside an inactive window unfocused", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();
    const restoreParent = focusParentFrame();
    try {
      await expect.poll(() => document.hasFocus()).toBe(false);
      await settleSelection();
      expect(mounted.ref.current?.isFocused()).toBe(false);

      await mounted.update({ value: "Background draft", cursor: 5 });
      await settleSelection();

      expect(mounted.editor.textContent).toBe("Background draft");
      expect(document.hasFocus()).toBe(false);
      expect(mounted.ref.current?.readSnapshot().cursor).toBe(5);
    } finally {
      restoreParent();
    }
  });

  it("preserves another control chosen while the composer is disabled", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();
    await mounted.update({ disabled: true });
    expect(mounted.editor.contentEditable).toBe("false");
    mounted.otherControl.focus();

    await mounted.update({ disabled: false });
    await settleSelection();

    expect(document.activeElement).toBe(mounted.otherControl);
    expect(mounted.ref.current?.isFocused()).toBe(false);
  });

  it("does not reactivate a window when the composer is re-enabled", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();
    await mounted.update({ disabled: true });
    const restoreParent = focusParentFrame();
    try {
      await expect.poll(() => document.hasFocus()).toBe(false);
      await mounted.update({ disabled: false });
      await settleSelection();

      expect(document.hasFocus()).toBe(false);
      expect(mounted.ref.current?.isFocused()).toBe(false);
    } finally {
      restoreParent();
    }
  });

  it("restores composer focus after disabling when no other control was chosen", async () => {
    const mounted = await mountEditor();
    mounted.ref.current?.focus();
    await expect.poll(() => document.activeElement).toBe(mounted.editor);
    await settleSelection();
    expect(document.hasFocus()).toBe(true);
    await mounted.update({ disabled: true });
    expect(mounted.editor.contentEditable).toBe("false");
    await mounted.update({ disabled: false });

    await expect.poll(() => mounted.ref.current?.isFocused()).toBe(true);
    expect(document.activeElement).toBe(mounted.editor);
  });

  it("honors an explicit focusAtEnd after a background draft update", async () => {
    const mounted = await mountEditor();
    mounted.otherControl.focus();
    await mounted.update({ value: "Restored draft", cursor: 3 });

    mounted.ref.current?.focusAtEnd();
    await expect.poll(() => mounted.ref.current?.isFocused()).toBe(true);
    await settleSelection();

    expect(document.activeElement).toBe(mounted.editor);
    expect(mounted.ref.current?.readSnapshot()).toMatchObject({
      value: "Restored draft",
      cursor: "Restored draft".length,
      selectionCollapsed: true,
    });
    expect(window.getSelection()?.anchorOffset).toBe("Restored draft".length);
  });
});

const overlay = () => document.querySelector<HTMLElement>('[data-testid="composer-prediction"]');
const field = () =>
  document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.parentElement!;
const footer = () => document.querySelector<HTMLElement>('[data-testid="composer-footer"]')!;

/** Mounts the editor at a fixed width with a stand-in for the controls below it. */
async function mountPredictionEditor(
  props: Partial<EditorProps>,
  options: { readonly width?: number } = {},
) {
  const ref = createRef<ComposerPromptEditorHandle>();
  let current: EditorProps = {
    value: "",
    cursor: 0,
    terminalContexts: [],
    disabled: false,
    placeholder: "Write a message",
    ariaLabel: "Message",
    onRemoveTerminalContext: vi.fn(),
    onChange: vi.fn(),
    onPaste: vi.fn(),
    ...props,
  };
  const content = () => (
    <div style={{ width: options.width ?? 640 }}>
      <ComposerPromptEditor {...current} ref={ref} />
      <div data-testid="composer-footer" style={{ height: 32 }} />
    </div>
  );
  const screen = await render(content());
  await expect.poll(() => (current.prediction ? overlay() : field())).not.toBeNull();
  await settleSelection();
  return {
    ref,
    editor: document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!,
    update: async (updates: Partial<EditorProps>) => {
      current = { ...current, ...updates };
      await screen.rerender(content());
      await settleSelection();
    },
  };
}

function lineHeightOf(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).lineHeight);
}

function ghostRows(): number {
  return Math.round(overlay()!.getBoundingClientRect().height / lineHeightOf(overlay()!));
}

function ghostParts() {
  const box = overlay()!;
  const text = box.querySelector<HTMLElement>("[data-prediction-text]")!;
  const chip = box.querySelector<HTMLElement>("kbd")!;
  const range = document.createRange();
  range.selectNodeContents(text);
  const textRows = Array.from(range.getClientRects());
  return { box, text, chip, lastTextRow: textRows[textRows.length - 1]! };
}

/** The chip is fully inside the ghost and sits after the last word, never over it. */
function expectChipAttachedToText() {
  const { box, chip, lastTextRow } = ghostParts();
  const boxRect = box.getBoundingClientRect();
  const chipRect = chip.getBoundingClientRect();
  expect(chipRect.right).toBeLessThanOrEqual(boxRect.right + 0.5);
  expect(chipRect.bottom).toBeLessThanOrEqual(boxRect.bottom + 0.5);
  const sameRow = chipRect.top < lastTextRow.bottom && chipRect.bottom > lastTextRow.top;
  if (sameRow) expect(chipRect.left).toBeGreaterThanOrEqual(lastTextRow.right);
  else expect(chipRect.top).toBeGreaterThanOrEqual(lastTextRow.bottom - 0.5);
}

describe("ComposerPromptEditor prediction overlay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const prediction = "Fix the fixture and rerun that test.";

  it("shows the ghost text and a Tab chip instead of the placeholder", async () => {
    const mounted = await mountEditor({ value: "", cursor: 0, prediction });

    await expect.poll(() => overlay()?.textContent).toBe(`${prediction}Tab`);
    expect(overlay()?.querySelector('kbd[aria-label="Tab"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Write a message");
    expect(mounted.editor.getAttribute("aria-placeholder")).toBe(prediction);
    // Drawn in the editor's cell only: the document and the draft stay empty.
    expect(mounted.editor.textContent).toBe("");
    expect(mounted.ref.current?.readSnapshot().value).toBe("");
  });

  it("keeps the normal placeholder when there is no prediction", async () => {
    const mounted = await mountEditor({ value: "", cursor: 0 });

    await expect.poll(() => document.body.textContent).toContain("Write a message");
    expect(overlay()).toBeNull();
    expect(mounted.editor.getAttribute("aria-placeholder")).toBe("Write a message");
  });

  it("hides the ghost text once the editor has content", async () => {
    const mounted = await mountEditor({ value: "", cursor: 0, prediction });
    await expect.poll(() => overlay()).not.toBeNull();

    await mounted.update({ value: "My own message", cursor: 3 });

    await expect.poll(() => overlay()).toBeNull();
    expect(mounted.editor.textContent).toBe("My own message");
  });

  describe.each([
    ["block composer", false],
    ["single-row composer", true],
  ])("in the %s", (_layout, singleLine) => {
    it("draws a one-row suggestion without changing the field's height", async () => {
      const mounted = await mountPredictionEditor({ singleLine });
      const emptyHeight = field().getBoundingClientRect().height;

      await mounted.update({ prediction });

      await expect.poll(() => overlay()?.textContent).toBe(`${prediction}Tab`);
      expect(ghostRows()).toBe(1);
      expect(field().getBoundingClientRect().height).toBeCloseTo(emptyHeight, 1);
      const { chip, lastTextRow } = ghostParts();
      // Inline right after the last word, centered on its row.
      const chipRect = chip.getBoundingClientRect();
      expect(chipRect.left - lastTextRow.right).toBeGreaterThan(4);
      expect(chipRect.left - lastTextRow.right).toBeLessThan(10);
      expect((chipRect.top + chipRect.bottom) / 2).toBeCloseTo(
        overlay()!.getBoundingClientRect().top + lineHeightOf(overlay()!) / 2,
        0,
      );

      await mounted.update({ prediction: null });
      expect(field().getBoundingClientRect().height).toBeCloseTo(emptyHeight, 1);
    });

    it("wraps a two-row suggestion in full and grows the field above the controls", async () => {
      const twoRows =
        "Go ahead with the schema change and the backfill script, both look safe to me, and leave the index rebuild for later.";
      await mountPredictionEditor({ singleLine, prediction: twoRows });

      await expect.poll(() => ghostRows()).toBe(2);
      expect(ghostParts().text.textContent).toBe(twoRows);
      expectChipAttachedToText();
      expect(field().getBoundingClientRect().height).toBeGreaterThanOrEqual(
        overlay()!.getBoundingClientRect().height - 0.5,
      );
      expect(footer().getBoundingClientRect().top).toBeGreaterThanOrEqual(
        overlay()!.getBoundingClientRect().bottom - 0.5,
      );
    });

    it.each([640, 375])(
      "ends a longer suggestion with an ellipsis on the third row at %ipx",
      async (width) => {
        const longSuggestion =
          "ok go ahead with the first two steps, but leave the third out for now, I do not want to touch the production table until we have a backup. tell me when both are done so I can check, and also rerun the migration dry run against staging before you open the pull request for review please";
        const mounted = await mountPredictionEditor(
          { singleLine, prediction: longSuggestion },
          { width },
        );

        await expect.poll(() => ghostRows()).toBe(3);
        const shown = ghostParts().text.textContent ?? "";
        expect(shown.endsWith("\u2026")).toBe(true);
        expect(longSuggestion.startsWith(shown.slice(0, -1).trimEnd())).toBe(true);
        expectChipAttachedToText();
        expect(footer().getBoundingClientRect().top).toBeGreaterThanOrEqual(
          overlay()!.getBoundingClientRect().bottom - 0.5,
        );
        // Screen readers and Tab still get the whole suggestion.
        expect(mounted.editor.getAttribute("aria-placeholder")).toBe(longSuggestion);
      },
    );
  });
});
