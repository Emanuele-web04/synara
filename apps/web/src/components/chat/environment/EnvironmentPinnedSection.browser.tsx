// FILE: EnvironmentPinnedSection.browser.tsx
// Purpose: Browser-level regression tests for pinned-message panel interactions.
// Layer: Vitest browser tests

import "../../../index.css";

import { MessageId, type PinnedMessage } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentPinnedSection } from "./EnvironmentPinnedSection";

const messageId = (value: string): MessageId => MessageId.makeUnsafe(value);

const pin = (value: string, overrides: Partial<PinnedMessage> = {}): PinnedMessage => ({
  messageId: messageId(value),
  label: null,
  done: false,
  pinnedAt: "2026-06-06T00:00:00.000Z",
  ...overrides,
});

describe("EnvironmentPinnedSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets unavailable pins enter rename instead of becoming dead disabled rows", async () => {
    const onJump = vi.fn();
    const onRename = vi.fn();
    await render(
      <EnvironmentPinnedSection
        pins={[pin("missing-message")]}
        messageTextById={new Map()}
        onJump={onJump}
        onToggleDone={vi.fn()}
        onUnpin={vi.fn()}
        onRename={onRename}
      />,
    );

    await page
      .getByRole("button", { name: "Pinned message unavailable. Press Enter to rename." })
      .click();
    await page.getByPlaceholder("Label").fill("Recovered label");
    document.querySelector<HTMLInputElement>('input[placeholder="Label"]')?.blur();

    expect(onJump).not.toHaveBeenCalled();
    expect(onRename).toHaveBeenCalledWith(messageId("missing-message"), "Recovered label");
  });

  it("does not save a draft when Escape cancels rename", async () => {
    const onRename = vi.fn();
    await render(
      <EnvironmentPinnedSection
        pins={[pin("cancel-rename", { label: "Original" })]}
        messageTextById={new Map([[messageId("cancel-rename"), "Available text"]])}
        onJump={vi.fn()}
        onToggleDone={vi.fn()}
        onUnpin={vi.fn()}
        onRename={onRename}
      />,
    );

    const labelButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Jump to pinned message. Press F2 to rename."]',
    );
    expect(labelButton).not.toBeNull();
    labelButton?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }),
    );
    await page.getByRole("textbox").fill("Draft that should not save");
    const input = document.querySelector<HTMLInputElement>("input");
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    input?.blur();

    expect(onRename).not.toHaveBeenCalled();
  });

  it("delays an available-pin jump so a double-click can enter rename without jumping", async () => {
    const onJump = vi.fn();
    await render(
      <EnvironmentPinnedSection
        pins={[pin("double-click", { label: "Original" })]}
        messageTextById={new Map([[messageId("double-click"), "Available text"]])}
        onJump={onJump}
        onToggleDone={vi.fn()}
        onUnpin={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    const labelButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Jump to pinned message. Press F2 to rename."]',
    );
    labelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    labelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    labelButton?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

    await vi.waitFor(() => expect(document.querySelector('input[class*="flex-1"]')).not.toBeNull());
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    expect(onJump).not.toHaveBeenCalled();
  });

  it("jumps once after the single-click delay", async () => {
    const onJump = vi.fn();
    await render(
      <EnvironmentPinnedSection
        pins={[pin("single-click")]}
        messageTextById={new Map([[messageId("single-click"), "Available text"]])}
        onJump={onJump}
        onToggleDone={vi.fn()}
        onUnpin={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "Jump to pinned message. Press F2 to rename." }).click();

    expect(onJump).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onJump).toHaveBeenCalledWith(messageId("single-click")));
  });
});
