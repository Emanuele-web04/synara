// FILE: ComposerScheduleSendMenu.browser.tsx
// Purpose: Verifies the composer schedule-send timer control renders and arms.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ComposerScheduleSendMenu,
  type ScheduledComposerDispatchMode,
} from "./ComposerScheduleSendMenu";

async function mountMenu(props?: { pending?: boolean }) {
  const host = document.createElement("div");
  document.body.append(host);
  const onSchedule = vi.fn();
  const onCancel = vi.fn();
  let selectedDelaySeconds = 300;
  let selectedMode: ScheduledComposerDispatchMode = "queue";

  const screen = await render(
    <ComposerScheduleSendMenu
      canSchedule
      selectedDelaySeconds={selectedDelaySeconds}
      selectedMode={selectedMode}
      pendingCountdownLabel={props?.pending ? "4h 59m" : null}
      pendingMode={props?.pending ? "new" : null}
      pendingPreviewText={props?.pending ? "Follow up when the limit resets" : null}
      delayOptions={[
        { seconds: 300, label: "5 min" },
        { seconds: 18_000, label: "5 hours" },
      ]}
      onDelayChange={(seconds) => {
        selectedDelaySeconds = seconds;
      }}
      onModeChange={(mode) => {
        selectedMode = mode;
      }}
      onSchedule={onSchedule}
      onCancel={onCancel}
    />,
    { container: host },
  );

  return {
    onSchedule,
    onCancel,
    get selectedDelaySeconds() {
      return selectedDelaySeconds;
    },
    get selectedMode() {
      return selectedMode;
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ComposerScheduleSendMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets the user select a timer and direction", async () => {
    const mounted = await mountMenu();

    try {
      await page.getByLabelText("Schedule prompt").click();
      await page.getByRole("menuitemradio", { name: "5 hours" }).click();
      await page.getByRole("menuitemradio", { name: "Steer current chat" }).click();
      await page.getByText("Start timer").click();

      expect(mounted.selectedDelaySeconds).toBe(18_000);
      expect(mounted.selectedMode).toBe("steer");
      expect(mounted.onSchedule).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a cancellable active countdown chip", async () => {
    const mounted = await mountMenu({ pending: true });

    try {
      await expect.element(page.getByText("New chat in 4h 59m")).toBeVisible();
      await page.getByLabelText("Cancel scheduled prompt").click();
      expect(mounted.onCancel).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });
});
