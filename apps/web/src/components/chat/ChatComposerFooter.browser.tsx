import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { SessionPhase } from "../../types";
import { ChatComposerFooter } from "./ChatComposerFooter";

function mountFooter(input: {
  phase: SessionPhase;
  connecting: boolean;
  stopping?: boolean;
  onInterrupt?: () => void;
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
        enabled: false,
        recording: false,
        transcribing: false,
        durationLabel: "",
        waveformLevels: [],
        onCancel: vi.fn(),
        onSubmit: vi.fn(),
        onToggle: vi.fn(),
      }}
      pendingInput={null}
      submission={{
        phase: input.phase,
        busy: false,
        connecting: input.connecting,
        interruptible: input.phase === "running" || input.connecting,
        stopping: input.stopping ?? false,
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

  it("keeps showing Stop while running", async () => {
    const onInterrupt = vi.fn();
    const screen = await mountFooter({ phase: "running", connecting: false, onInterrupt });
    try {
      const stop = page.getByRole("button", { name: "Stop generation" });
      await expect.element(stop).toBeVisible();
      await stop.click();
      expect(onInterrupt).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("hides Stop when connecting has no pending turn", async () => {
    const screen = await mountFooter({ phase: "ready", connecting: false });
    try {
      await expect
        .element(page.getByRole("button", { name: "Stop generation" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("disables Stop and reads 'Stopping' while a stop is in flight", async () => {
    const onInterrupt = vi.fn();
    const screen = await mountFooter({
      phase: "running",
      connecting: false,
      stopping: true,
      onInterrupt,
    });
    try {
      const stop = page.getByRole("button", { name: "Stopping" });
      await expect.element(stop).toBeVisible();
      await expect.element(stop).toBeDisabled();
      await stop.click({ force: true }).catch(() => undefined);
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
