import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { SessionPhase } from "../../types";
import { ChatComposerFooter } from "./ChatComposerFooter";

interface FooterInput {
  phase: SessionPhase;
  connecting: boolean;
  handoffPending?: boolean;
  hasContent?: boolean;
  onInterrupt?: () => void;
  voiceEnabled?: boolean;
  voiceRecording?: boolean;
  onVoiceToggle?: () => void;
}

function footer(input: FooterInput) {
  return (
    <ChatComposerFooter
      isComposerFooterCompact={false}
      leadingControls={null}
      composerPickerControls={null}
      contextMeter={null}
      interactionMode="default"
      resetInteractionMode={vi.fn()}
      sidebarAction={null}
      voice={{
        enabled: input.voiceEnabled ?? false,
        recording: input.voiceRecording ?? false,
        starting: false,
        waitingForAudio: false,
        transcribing: false,
        durationLabel: "",
        waveformLevels: [],
        onCancel: vi.fn(),
        onSubmit: vi.fn(),
        onToggle: input.onVoiceToggle ?? vi.fn(),
      }}
      pendingInput={null}
      submission={{
        phase: input.phase,
        busy: false,
        connecting: input.connecting,
        handoffPending: input.handoffPending ?? false,
        expired: false,
        preparingImages: false,
        preparingWorktree: false,
        hasContent: input.hasContent ?? false,
        hasPendingUserInputs: false,
        showPlanFollowUp: false,
        hasPrompt: false,
        onInterrupt: input.onInterrupt ?? vi.fn(),
        onImplementInNewThread: vi.fn(),
      }}
    />
  );
}

function mountFooter(input: FooterInput) {
  return render(footer(input));
}

describe("ChatComposerFooter stop control", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows Stop while connecting so a stuck start can be interrupted", async () => {
    const onInterrupt = vi.fn();
    const screen = await mountFooter({ phase: "connecting", connecting: true, onInterrupt });
    try {
      const stop = page.getByRole("button", { name: "Stop generation" });
      await expect.element(stop).toBeVisible();
      await stop.click();
      expect(onInterrupt).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the mic next to Stop so a follow-up can be dictated mid-turn", async () => {
    const onVoiceToggle = vi.fn();
    const screen = await mountFooter({
      phase: "running",
      connecting: false,
      voiceEnabled: true,
      onVoiceToggle,
    });
    try {
      await expect.element(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
      const mic = page.getByRole("button", { name: "Record voice note" });
      await expect.element(mic).toBeVisible();
      await mic.click();
      expect(onVoiceToggle).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("shows only the recorder's stop while dictating mid-turn", async () => {
    const screen = await mountFooter({
      phase: "running",
      connecting: false,
      voiceEnabled: true,
      voiceRecording: true,
    });
    try {
      await expect
        .element(page.getByRole("button", { name: "Stop voice recording" }))
        .toBeVisible();
      expect(document.querySelector('button[aria-label="Stop generation"]')).toBeNull();
      expect(document.querySelector('button[aria-label="Record voice note"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["ready", "connecting", "running"] as const)(
    "holds handoff admission separately from %s cancellation and restores Send when settled",
    async (phase) => {
      const onInterrupt = vi.fn();
      const onVoiceToggle = vi.fn();
      const input: FooterInput = {
        phase,
        connecting: phase === "connecting",
        handoffPending: true,
        hasContent: true,
        voiceEnabled: true,
        onInterrupt,
        onVoiceToggle,
      };
      const screen = await mountFooter(input);
      try {
        const submit = page.getByRole("button", { name: "Connecting", exact: true });
        await expect.element(submit).toBeVisible();
        await expect.element(submit).toBeDisabled();
        expect(document.querySelectorAll('button[type="submit"]')).toHaveLength(1);
        expect(document.querySelector('button[aria-label="Stop generation"]')).toBeNull();
        await expect
          .element(page.getByRole("button", { name: "Record voice note" }))
          .toBeDisabled();
        expect(onInterrupt).not.toHaveBeenCalled();
        expect(onVoiceToggle).not.toHaveBeenCalled();

        await screen.rerender(
          footer({
            ...input,
            phase: "ready",
            connecting: false,
            handoffPending: false,
          }),
        );
        await expect
          .element(page.getByRole("button", { name: "Send message", exact: true }))
          .toBeEnabled();
        expect(document.querySelectorAll('button[type="submit"]')).toHaveLength(1);
        expect(document.querySelector('button[aria-label="Stop generation"]')).toBeNull();
        await expect.element(page.getByRole("button", { name: "Record voice note" })).toBeEnabled();
        expect(onInterrupt).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );
});
