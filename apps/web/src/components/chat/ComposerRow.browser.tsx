import "../../index.css";
import { type CSSProperties, useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ChatComposerFooter } from "./ChatComposerFooter";
import { useComposerSingleRow } from "./useComposerSingleRow";
import { ComposerPredictionGhost } from "../ComposerPredictionGhost";
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

function PredictionRow({
  prediction,
  width = 600,
  fontSize,
}: {
  prediction: string | null;
  width?: number;
  fontSize?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const row = useComposerSingleRow({ formRef, eligible: true, prompt: "", prediction });
  return (
    <div style={{ width, "--app-font-size-chat": fontSize } as CSSProperties}>
      <form ref={formRef} data-testid="prediction-form" data-layout={row ? "row" : "block"}>
        <div
          data-chat-composer-surface=""
          className={`${COMPOSER_INPUT_SURFACE_CLASS_NAME} ${row ? COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME : ""}`}
        >
          <div className={row ? COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME : ""}>
            <div className={prediction ? "grid" : undefined}>
              <div
                data-testid="composer-editor"
                className="col-start-1 row-start-1 leading-relaxed"
              >
                <p />
              </div>
              {prediction ? (
                <ComposerPredictionGhost
                  suggestion={prediction}
                  layoutKey={row ? "row" : "block"}
                  className="col-start-1 row-start-1 self-start"
                />
              ) : null}
            </div>
          </div>
          <button type="button" className={row ? "col-start-3 row-start-1" : ""}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

it("keeps the row for a suggestion that fits it and gives a wrapping one the block", async () => {
  const screen = await render(<PredictionRow prediction="Rerun that test." />);
  await expect.element(page.getByTestId("prediction-form")).toHaveAttribute("data-layout", "row");

  await screen.rerender(
    <PredictionRow prediction="ok go ahead with the first two steps, but leave the third out for now, I do not want to touch the production table until we have a backup. tell me when both are done so I can check" />,
  );
  await expect.element(page.getByTestId("prediction-form")).toHaveAttribute("data-layout", "block");

  await screen.rerender(<PredictionRow prediction={null} />);
  await expect.element(page.getByTestId("prediction-form")).toHaveAttribute("data-layout", "row");
});

it("updates the prediction layout when the pane and chat font shrink", async () => {
  const prediction = "Rerun the tests and review the changes.";
  const screen = await render(
    <PredictionRow prediction={prediction} width={900} fontSize="28px" />,
  );
  const form = page.getByTestId("prediction-form");
  await expect.element(form, { timeout: 2_000 }).toHaveAttribute("data-layout", "row");

  await screen.rerender(<PredictionRow prediction={prediction} width={210} fontSize="11px" />);
  await expect.element(form, { timeout: 2_000 }).toHaveAttribute("data-layout", "block");
});

const LONG_DRAFT =
  "ok go ahead with the first two steps, but leave the third out for now, I do not want to touch the production table until we have a backup. tell me when both are done so I can check";

function LateMountRow({ mounted }: { mounted: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const row = useComposerSingleRow({ formRef, eligible: true, prompt: LONG_DRAFT });
  return (
    <div style={{ width: 600 }}>
      <output aria-label="Composer layout">{row ? "row" : "block"}</output>
      {mounted ? (
        <form ref={formRef}>
          <div
            data-chat-composer-surface=""
            className={`${COMPOSER_INPUT_SURFACE_CLASS_NAME} ${row ? COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME : ""}`}
          >
            <div className={row ? COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME : ""}>
              <div data-testid="composer-editor" style={{ lineHeight: "24px" }}>
                <p>{LONG_DRAFT}</p>
              </div>
            </div>
            <button type="button" className={row ? "col-start-3 row-start-1" : ""}>
              Send
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

it("measures a composer that mounts after the hook without the draft changing", async () => {
  // The pane content, and with it the composer form, can render after its host.
  const screen = await render(<LateMountRow mounted={false} />);
  await expect
    .element(page.getByRole("status", { name: "Composer layout" }))
    .toHaveTextContent("row");

  await screen.rerender(<LateMountRow mounted />);
  await expect
    .element(page.getByRole("status", { name: "Composer layout" }))
    .toHaveTextContent("block");
});
