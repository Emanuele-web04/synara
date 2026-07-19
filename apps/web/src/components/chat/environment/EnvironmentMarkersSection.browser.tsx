// FILE: EnvironmentMarkersSection.browser.tsx
// Purpose: Browser-level regression tests for marker panel interactions.
// Layer: Vitest browser tests

import "../../../index.css";

import { MessageId, ThreadMarkerId, type ThreadMarker } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentMarkersSection } from "./EnvironmentMarkersSection";

const messageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const markerId = (value: string): ThreadMarkerId => ThreadMarkerId.makeUnsafe(value);

const marker = (value: string, overrides: Partial<ThreadMarker> = {}): ThreadMarker => ({
  id: markerId(value),
  messageId: messageId("assistant-1"),
  startOffset: 0,
  endOffset: 14,
  selectedText: "important text",
  style: "highlight",
  color: "yellow",
  label: null,
  done: false,
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
  ...overrides,
});

describe("EnvironmentMarkersSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets unavailable markers enter rename instead of becoming dead disabled rows", async () => {
    const onJump = vi.fn();
    const onRename = vi.fn();
    await render(
      <EnvironmentMarkersSection
        markers={[marker("missing-marker")]}
        messageTextById={new Map()}
        onJump={onJump}
        onToggleDone={vi.fn()}
        onRemove={vi.fn()}
        onRename={onRename}
      />,
    );

    await page.getByRole("button", { name: "Marker unavailable. Press Enter to rename." }).click();
    await page.getByRole("textbox").fill("Recovered label");
    document.querySelector<HTMLInputElement>('input[class*="flex-1"]')?.blur();

    expect(onJump).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(onRename).toHaveBeenCalledWith(markerId("missing-marker"), "Recovered label"),
    );
  });

  it("does not save a draft when Escape cancels rename", async () => {
    const onRename = vi.fn();
    await render(
      <EnvironmentMarkersSection
        markers={[marker("cancel-rename", { label: "Original" })]}
        messageTextById={new Map([[messageId("assistant-1"), "important text"]])}
        onJump={vi.fn()}
        onToggleDone={vi.fn()}
        onRemove={vi.fn()}
        onRename={onRename}
      />,
    );

    const labelButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Jump to marker. Press F2 to rename."]',
    );
    expect(labelButton).not.toBeNull();
    labelButton?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }),
    );
    await page.getByRole("textbox").fill("Draft that should not save");
    const input = document.querySelector<HTMLInputElement>('input[class*="flex-1"]');
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    input?.blur();

    expect(onRename).not.toHaveBeenCalled();
  });

  it("adapts checkbox, remove, and Enter-to-commit actions to the marker id", async () => {
    const onToggleDone = vi.fn();
    const onRemove = vi.fn();
    const onRename = vi.fn();
    await render(
      <EnvironmentMarkersSection
        markers={[marker("marker-actions", { label: "Original" })]}
        messageTextById={new Map([[messageId("assistant-1"), "important text"]])}
        onJump={vi.fn()}
        onToggleDone={onToggleDone}
        onRemove={onRemove}
        onRename={onRename}
      />,
    );

    await page.getByRole("checkbox", { name: "Mark done" }).click();
    await page.getByRole("button", { name: "Remove marker" }).click();
    const labelButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Jump to marker. Press F2 to rename."]',
    );
    labelButton?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }),
    );
    await page.getByRole("textbox").fill("Renamed marker");
    document
      .querySelector<HTMLInputElement>('input[class*="flex-1"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );

    expect(onToggleDone).toHaveBeenCalledWith(markerId("marker-actions"));
    expect(onRemove).toHaveBeenCalledWith(markerId("marker-actions"));
    expect(onRename).toHaveBeenCalledWith(markerId("marker-actions"), "Renamed marker");
  });
});
