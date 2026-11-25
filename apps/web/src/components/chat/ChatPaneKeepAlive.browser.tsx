import "../../index.css";

import { useState } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ChatPaneKeepAliveProvider, KeptChatPane } from "./ChatPaneKeepAlive";

let mounts = 0;

function Chat({ label }: { label: string }) {
  const [mountId] = useState(() => (mounts += 1));
  return (
    <div aria-label="chat" data-mount={mountId} style={{ height: 120, overflowY: "auto" }}>
      <div style={{ height: 600 }}>{label}</div>
      <input aria-label="draft" />
      <div contentEditable suppressContentEditableWarning aria-label="composer">
        half typed
      </div>
    </div>
  );
}

// Two surfaces with unrelated element structures around the slot, like the single chat
// surface and the split view.
function Harness({
  surface = "single",
  splitThreadId = "thread-a",
}: {
  surface?: "single" | "split" | "parked";
  splitThreadId?: string;
}) {
  return (
    <ChatPaneKeepAliveProvider>
      {surface === "parked" ? null : surface === "split" ? (
        <section>
          <div>
            <KeptChatPane slotKey="pane-1" threadId={splitThreadId}>
              <Chat label="split" />
            </KeptChatPane>
          </div>
        </section>
      ) : (
        <KeptChatPane slotKey="single" threadId="thread-a">
          <Chat label="single" />
        </KeptChatPane>
      )}
    </ChatPaneKeepAliveProvider>
  );
}

const chat = () => page.getByLabelText("chat").element() as HTMLElement;

const handoffMethods = ["moveBefore", "append"] as const;
type HandoffMethod = (typeof handoffMethods)[number];

function configureHandoff(move: HandoffMethod) {
  const originalMoveBefore = Element.prototype.moveBefore;
  onTestFinished(() => {
    Element.prototype.moveBefore = originalMoveBefore;
    vi.useRealTimers();
  });

  if (move === "append") {
    Element.prototype.moveBefore = undefined as never;
  } else {
    // Keep real frames for Chromium's inert focus update while holding the pane's expiry.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }
}

async function handoff(
  screen: Awaited<ReturnType<typeof render>>,
  surface: "split" | "single",
  move: HandoffMethod,
) {
  if (move === "moveBefore") {
    await screen.rerender(<Harness surface="parked" />);
    // Give Chromium a paint to apply inert before adoption. Vitest's polling
    // matchers advance fake timers, so wait for these real frames directly.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }
  await screen.rerender(<Harness surface={surface} />);
}

describe("chat pane keep-alive", () => {
  it("hands a pane to the slot that replaces it when both show the same thread", async () => {
    const screen = await render(<Harness />);
    try {
      const before = chat();
      const draft = page.getByLabelText("draft").element() as HTMLInputElement;
      draft.value = "half typed";
      before.scrollTop = 200;

      for (const label of ["split", "single"] as const) {
        await screen.rerender(<Harness surface={label} />);
        await expect.element(page.getByText(label)).toBeInTheDocument();
        expect(chat()).toBe(before);
        expect((page.getByLabelText("draft").element() as HTMLInputElement).value).toBe(
          "half typed",
        );
        await expect.poll(() => chat().scrollTop).toBe(200);
      }
      expect(page.getByLabelText("chat").all()).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it.each(handoffMethods)("retains focus and selection across %s handoffs", async (move) => {
    configureHandoff(move);
    const screen = await render(<Harness />);
    try {
      const draft = page.getByLabelText("draft").element() as HTMLInputElement;
      draft.value = "half typed";
      draft.focus();
      draft.setSelectionRange(2, 6);
      for (const label of ["split", "single"] as const) {
        await handoff(screen, label, move);
        await expect.element(page.getByText(label)).toBeInTheDocument();
        await expect.poll(() => document.activeElement).toBe(draft);
        expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 6]);
      }
    } finally {
      await screen.unmount();
    }
  });

  it.each(handoffMethods)(
    "retains an editable composer selection across %s handoffs",
    async (move) => {
      configureHandoff(move);
      const screen = await render(<Harness />);
      try {
        const editor = page.getByLabelText("composer").element() as HTMLElement;
        const text = editor.firstChild!;
        editor.focus();
        document.getSelection()!.setBaseAndExtent(text, 6, text, 2);
        for (const label of ["split", "single"] as const) {
          await handoff(screen, label, move);
          await expect.element(page.getByText(label)).toBeInTheDocument();
          await expect.poll(() => document.activeElement).toBe(editor);
          const selection = document.getSelection()!;
          expect([
            selection.anchorNode,
            selection.anchorOffset,
            selection.focusNode,
            selection.focusOffset,
          ]).toEqual([text, 6, text, 2]);
        }
      } finally {
        await screen.unmount();
      }
    },
  );

  it("mounts a fresh pane when the replacing slot shows another thread", async () => {
    const screen = await render(<Harness />);
    try {
      const before = chat().dataset.mount;
      await screen.rerender(<Harness surface="split" splitThreadId="thread-b" />);
      await expect.element(page.getByText("split")).toBeInTheDocument();
      // The released pane waits out its grace period, then is unmounted.
      await expect.poll(() => page.getByLabelText("chat").all().length).toBe(1);
      expect(chat().dataset.mount).not.toBe(before);
    } finally {
      await screen.unmount();
    }
  });

  it("renders children in place without a provider", async () => {
    const screen = await render(
      <KeptChatPane slotKey="single" threadId="thread-a">
        <Chat label="inline" />
      </KeptChatPane>,
    );
    try {
      await expect.element(page.getByText("inline")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
