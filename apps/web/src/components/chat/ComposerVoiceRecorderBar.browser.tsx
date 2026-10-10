// FILE: ComposerVoiceRecorderBar.browser.tsx
// Purpose: Verifies voice recording exposes discard, a secondary stop, and a send-styled send action.
// Layer: Browser UI test
// Depends on: vitest browser rendering and ComposerVoiceRecorderBar.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";

describe("ComposerVoiceRecorderBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps discard and stop separate from the send-styled send action", async () => {
    const onDiscard = vi.fn();
    const onStop = vi.fn();
    const onSend = vi.fn();
    const screen = await render(
      <ComposerVoiceRecorderBar
        isRecording
        isTranscribing={false}
        waveformLevels={[0.2, 0.6, 0.4]}
        onDiscard={onDiscard}
        onStop={onStop}
        onSend={onSend}
      />,
    );

    const sendButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Send voice note"]',
    );
    expect(sendButton).not.toBeNull();
    expect(sendButton?.className).toContain("bg-[var(--color-text-foreground)]");
    expect(sendButton?.className).toContain("text-[var(--color-background-surface)]");

    await page.getByRole("button", { name: "Stop voice recording" }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Send voice note" }).click();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);

    await page.getByRole("button", { name: "Cancel voice recording" }).click();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });

  it("omits send where the surface has no send step", async () => {
    const screen = await render(
      <ComposerVoiceRecorderBar
        isRecording
        isTranscribing={false}
        waveformLevels={[]}
        onDiscard={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    await expect.element(page.getByRole("button", { name: "Stop voice recording" })).toBeVisible();
    expect(document.querySelector('button[aria-label="Send voice note"]')).toBeNull();

    await screen.unmount();
  });
});
