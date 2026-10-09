import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { SessionPhase } from "../../types";
import { ChatComposerFooter } from "./ChatComposerFooter";

function mountFooter(input: {
  phase: SessionPhase;
  connecting: boolean;
  onInterrupt?: () => void;
  voiceEnabled?: boolean;
  voiceRecording?: boolean;
  onVoiceToggle?: () => void;
}) {
  return render(
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
        onSend: vi.fn(),
        onToggle: input.onVoiceToggle ?? vi.fn(),
      }}
      pendingInput={null}
      submission={{
        phase: input.phase,
        busy: false,
        connecting: input.connecting,
        expired: false,
        preparingImages: false,
        preparingWorktree: false,
        hasContent: false,
        hasPendingUserInputs: false,
        showPlanFollowUp: false,
        hasPrompt: false,
        onInterrupt: input.onInterrupt ?? vi.fn(),
        onImplementInNewThread: vi.fn(),
      }}
    />,
  );
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
});
