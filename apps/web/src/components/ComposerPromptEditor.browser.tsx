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
    // Drawn over the editor only: the document and the draft stay empty.
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

  it("clamps a long suggestion to two lines and keeps the chip in the multi-line composer", async () => {
    const longPrediction = `${"Rerun the failing parser test after fixing the fixture ".repeat(12)}now`;
    await mountEditor({ value: "", cursor: 0, prediction: longPrediction });
    await expect.poll(() => overlay()).not.toBeNull();

    const row = overlay()!.firstElementChild as HTMLElement;
    const text = row.querySelector("span")!;
    const chip = row.querySelector("kbd")!;
    const lineHeight = parseFloat(getComputedStyle(overlay()!).lineHeight);
    expect(text.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight * 2 + 0.5);
    expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(
      overlay()!.getBoundingClientRect().right + 0.5,
    );
  });

  it("keeps a long suggestion on one line with the chip visible in the single-row composer", async () => {
    const longPrediction = `${"Rerun the failing parser test after fixing the fixture ".repeat(6)}now`;
    await mountEditor({ value: "", cursor: 0, prediction: longPrediction, singleLine: true });
    await expect.poll(() => overlay()).not.toBeNull();

    const row = overlay()!.firstElementChild as HTMLElement;
    const text = row.querySelector("span")!;
    const chip = row.querySelector("kbd")!;
    expect(getComputedStyle(text).whiteSpace).toBe("nowrap");
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    const overlayBox = overlay()!.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    expect(chipBox.right).toBeLessThanOrEqual(overlayBox.right + 0.5);
    expect(chipBox.top).toBeGreaterThanOrEqual(overlayBox.top - 0.5);
    expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(
      parseFloat(getComputedStyle(overlay()!).lineHeight) + 0.5,
    );
  });
});
