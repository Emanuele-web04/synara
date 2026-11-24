import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { SessionPhase } from "../../types";
import { ChatComposerFooter } from "./ChatComposerFooter";

interface FooterInput {
  phase: SessionPhase;
  connecting: boolean;
  recoveryStopAvailable?: boolean;
  usageLimitStopAvailable?: boolean;
  onInterrupt?: () => void;
  voiceEnabled?: boolean;
  voiceRecording?: boolean;
  onVoiceToggle?: () => void;
  hasContent?: boolean;
  onResume?: () => void;
}

function mountFooter(input: FooterInput) {
  return render(footer(input));
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
        recoveryStopAvailable: input.recoveryStopAvailable ?? false,
        usageLimitStopAvailable: input.usageLimitStopAvailable ?? false,
        busy: false,
        connecting: input.connecting,
        expired: false,
        preparingImages: false,
        preparingWorktree: false,
        hasContent: input.hasContent ?? false,
        hasPendingUserInputs: false,
        showPlanFollowUp: false,
        hasPrompt: false,
        onInterrupt: input.onInterrupt ?? vi.fn(),
        onImplementInNewThread: vi.fn(),
        ...(input.onResume ? { onResume: input.onResume } : {}),
      }}
    />
  );
}

describe("ChatComposerFooter stop control", () => {
  it("offers cancellation for an idle host-owned wait without pretending a turn is running", async () => {
    const onInterrupt = vi.fn();
    await mountFooter({
      phase: "ready",
      connecting: false,
      usageLimitStopAvailable: true,
      onInterrupt,
    });
    await page.getByRole("button", { name: "Cancel auto-resume" }).click();
    expect(onInterrupt).toHaveBeenCalledOnce();
  });

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

  it("keeps Stop available for an idle delivery blocker", async () => {
    const onInterrupt = vi.fn();
    const screen = await mountFooter({
      phase: "ready",
      connecting: false,
      recoveryStopAvailable: true,
      onInterrupt,
    });
    try {
      const stop = page.getByRole("button", { name: "Stop generation" });
      await expect.element(stop).toBeVisible();
      await expect.element(stop).toHaveAttribute("type", "button");
      await expect
        .element(stop)
        .toHaveAttribute("title", "Stop the provider runtime before unblocking this thread.");
      expect(document.querySelector('button[aria-label="Send message"]')).toBeNull();
      await stop.click();
      expect(onInterrupt).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps Send for an ordinary ready session", async () => {
    const onInterrupt = vi.fn();
    const screen = await mountFooter({ phase: "ready", connecting: false, onInterrupt });
    try {
      await expect.element(page.getByRole("button", { name: "Send message" })).toBeVisible();
      expect(document.querySelector('button[aria-label="Stop generation"]')).toBeNull();
      expect(onInterrupt).not.toHaveBeenCalled();
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

describe("ChatComposerFooter resume control", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("turns an empty composer's Send into Resume for an interrupted task", async () => {
    const onResume = vi.fn();
    const screen = await mountFooter({ phase: "ready", connecting: false, onResume });
    try {
      const resume = page.getByRole("button", { name: "Resume task" });
      await expect.element(resume).toBeEnabled();
      await expect.element(resume).toHaveAttribute("type", "button");
      expect(document.querySelector('button[aria-label="Send message"]')).toBeNull();
      await resume.click();
      expect(onResume).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps Send once the draft has content", async () => {
    const onResume = vi.fn();
    const screen = await mountFooter({
      phase: "ready",
      connecting: false,
      hasContent: true,
      onResume,
    });
    try {
      await expect.element(page.getByRole("button", { name: "Send message" })).toBeEnabled();
      expect(document.querySelector('button[aria-label="Resume task"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("ignores a repeated Stop click that lands on Resume", async () => {
    const onResume = vi.fn();
    const screen = await mountFooter({ phase: "running", connecting: false, onResume });
    try {
      await expect.element(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
      await screen.rerender(footer({ phase: "ready", connecting: false, onResume }));
      const resume = page.getByRole("button", { name: "Resume task" });
      await resume.click();
      expect(onResume).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 550));
      await resume.click();
      expect(onResume).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });
});
