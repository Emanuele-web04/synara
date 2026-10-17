import "../index.css";

import { createRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

type EditorProps = ComponentProps<typeof ComposerPromptEditor>;

async function mountEditor() {
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
