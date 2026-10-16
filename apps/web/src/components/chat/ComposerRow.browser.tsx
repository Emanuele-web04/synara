import "../../index.css";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ChatComposerFooter } from "./ChatComposerFooter";
import { useComposerSingleRow } from "./useComposerSingleRow";
import { useComposerOverlayHeight } from "./composerOverlay";
import {
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME,
  COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME,
} from "./composerPickerStyles";

function ComposerRow({ onOpenPlan = () => {} }: { onOpenPlan?: () => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [recording, setRecording] = useState(false);
  const row = useComposerSingleRow({ formRef, eligible: true, prompt: "hello" });
  const { overlayRef, overlayBottomClearancePx } = useComposerOverlayHeight();
  return (
    <div style={{ paddingTop: 200, width: 600 }}>
      <output aria-label="Footer clearance">{overlayBottomClearancePx}</output>
      <div ref={overlayRef}>
        <div style={{ height: 64 }}>Queued follow-up</div>
        <form ref={formRef} data-testid="row-form" data-layout={row ? "row" : "block"}>
          <div
            data-chat-composer-surface=""
            className={`${COMPOSER_INPUT_SURFACE_CLASS_NAME} ${row ? COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME : ""}`}
          >
            <div
              className={row ? COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME : ""}
              style={recording ? { display: "none" } : undefined}
            >
              <div data-testid="composer-editor" style={{ lineHeight: "24px" }}>
                <p>hello</p>
              </div>
            </div>
            <ChatComposerFooter
              layout={row ? "row" : "block"}
              isComposerFooterCompact={false}
              leadingControls={<button type="button">Attach</button>}
              composerPickerControls={null}
              contextMeter={null}
              interactionMode="default"
              resetInteractionMode={() => {}}
              sidebarAction={{ title: "Show plan sidebar", label: "Plan", onClick: onOpenPlan }}
              voice={{
                enabled: true,
                recording,
                starting: false,
                waitingForAudio: false,
                transcribing: false,
                durationLabel: "0:01",
                waveformLevels: [],
                onCancel: () => setRecording(false),
                onSubmit: () => setRecording(false),
                onToggle: () => setRecording(true),
              }}
              pendingInput={null}
              submission={{
                phase: "ready",
                busy: false,
                connecting: false,
                expired: false,
                preparingImages: false,
                preparingWorktree: false,
                hasContent: true,
                hasPendingUserInputs: false,
                showPlanFollowUp: false,
                hasPrompt: true,
                onInterrupt: () => {},
                onImplementInNewThread: () => {},
              }}
            />
          </div>
        </form>
      </div>
    </div>
  );
}

beforeEach(async () => {
  await page.viewport(800, 600);
});
afterEach(cleanup);

it("measures the rendered row controls without masking the queued content above them", async () => {
  await render(<ComposerRow />);
  await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "row");
  await expect
    .element(page.getByRole("status", { name: "Footer clearance" }))
    .toHaveTextContent("52");
});

it("keeps row layout during dictation and after returning to the draft", async () => {
  await render(<ComposerRow />);
  await page.getByRole("button", { name: "Record voice note" }).click();
  await expect.element(page.getByRole("button", { name: "Stop voice recording" })).toBeVisible();
  await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "row");
  await page.getByRole("button", { name: "Stop voice recording" }).click();
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await expect.element(page.getByTestId("row-form")).toHaveAttribute("data-layout", "row");
});

it("keeps the plan accessible in the compact row even without a task capsule", async () => {
  const openPlan = vi.fn();
  await render(<ComposerRow onOpenPlan={openPlan} />);
  await page.getByRole("button", { name: "Show plan sidebar" }).click();
  expect(openPlan).toHaveBeenCalledOnce();
});
