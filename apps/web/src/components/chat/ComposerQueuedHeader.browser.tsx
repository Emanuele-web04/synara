// FILE: ComposerQueuedHeader.browser.tsx
// Purpose: Verifies queued composer rows render the ready-to-send timer affordance.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { QueuedComposerTurn } from "../../composerDraftStore";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { ComposerQueuedHeader } from "./ComposerQueuedHeader";

type QueuedComposerChatTurn = Extract<QueuedComposerTurn, { kind: "chat" }>;

function queuedTurn(overrides?: Partial<QueuedComposerChatTurn>): QueuedComposerChatTurn {
  return {
    id: "queued-turn-1",
    kind: "chat",
    createdAt: "2026-07-04T12:00:00.000Z",
    previewText: "Review the timer UI",
    prompt: "Review the timer UI",
    images: [],
    files: [],
    assistantSelections: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    selectedProvider: "codex",
    selectedModel: "gpt-5-codex",
    selectedPromptEffort: "medium",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    ...overrides,
  };
}

async function mountQueuedHeader(turns: QueuedComposerTurn[] = [queuedTurn()]) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerColumnFrame>
      <ComposerQueuedHeader
        queuedTurns={turns}
        onSteer={vi.fn()}
        onRemove={vi.fn()}
        onEdit={vi.fn()}
        cwd="unused"
      />
    </ComposerColumnFrame>,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ComposerQueuedHeader", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows a ready-to-send timer beside the queued prompt", async () => {
    const mounted = await mountQueuedHeader([
      queuedTurn({ createdAt: new Date(Date.now() - 7_000).toISOString() }),
    ]);

    try {
      await expect.element(page.getByTestId("queued-follow-up-row")).toBeVisible();
      await expect.element(page.getByLabelText(/Ready to send/u)).toBeVisible();
      await expect.element(page.getByText(/7s|8s/u)).toBeVisible();
      await expect.element(page.getByText("Review the timer UI")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });
});
