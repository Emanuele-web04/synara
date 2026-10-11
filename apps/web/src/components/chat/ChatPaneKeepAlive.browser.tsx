import "../../index.css";

import { useState } from "react";
import { describe, expect, it } from "vitest";
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
  splitThreadId = "thread-a",
  parkBetween = false,
}: {
  splitThreadId?: string;
  parkBetween?: boolean;
}) {
  const [split, setSplit] = useState(false);
  const [parked, setParked] = useState(false);
  return (
    <ChatPaneKeepAliveProvider>
      <button
        type="button"
        onClick={() => {
          if (!parkBetween) {
            setSplit((current) => !current);
            return;
          }
          setParked(true);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              setSplit((current) => !current);
              setParked(false);
            }),
          );
        }}
      >
        Toggle
      </button>
      {parked ? null : split ? (
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

describe("chat pane keep-alive", () => {
  it("hands a pane to the slot that replaces it when both show the same thread", async () => {
    const screen = await render(<Harness />);
    try {
      const before = chat();
      const draft = page.getByLabelText("draft").element() as HTMLInputElement;
      draft.value = "half typed";
      before.scrollTop = 200;

      for (const label of ["split", "single"]) {
        await page.getByRole("button", { name: "Toggle" }).click();
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

  it.each(["moveBefore", "append"])(
    "retains focus and selection across %s handoffs",
    async (move) => {
      const originalMoveBefore = Element.prototype.moveBefore;
      if (move === "append") Element.prototype.moveBefore = undefined as never;
      const screen = await render(<Harness parkBetween={move === "moveBefore"} />);
      try {
        const draft = page.getByLabelText("draft").element() as HTMLInputElement;
        draft.value = "half typed";
        draft.focus();
        draft.setSelectionRange(2, 6);
        for (const label of ["split", "single"]) {
          // A shortcut/programmatic surface change leaves the composer focused before
          // the handoff; a pointer click on the toggle would focus the button instead.
          (page.getByRole("button", { name: "Toggle" }).element() as HTMLButtonElement).click();
          await expect.element(page.getByText(label)).toBeInTheDocument();
          await expect.poll(() => document.activeElement).toBe(draft);
          expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 6]);
        }
      } finally {
        await screen.unmount();
        Element.prototype.moveBefore = originalMoveBefore;
      }
    },
  );

  it.each(["moveBefore", "append"])(
    "retains an editable composer selection across %s handoffs",
    async (move) => {
      const originalMoveBefore = Element.prototype.moveBefore;
      if (move === "append") Element.prototype.moveBefore = undefined as never;
      const screen = await render(<Harness parkBetween={move === "moveBefore"} />);
      try {
        const editor = page.getByLabelText("composer").element() as HTMLElement;
        const text = editor.firstChild!;
        editor.focus();
        document.getSelection()!.setBaseAndExtent(text, 6, text, 2);
        for (const label of ["split", "single"]) {
          (page.getByRole("button", { name: "Toggle" }).element() as HTMLButtonElement).click();
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
        Element.prototype.moveBefore = originalMoveBefore;
      }
    },
  );

  it("mounts a fresh pane when the replacing slot shows another thread", async () => {
    const screen = await render(<Harness splitThreadId="thread-b" />);
    try {
      const before = chat().dataset.mount;
      await page.getByRole("button", { name: "Toggle" }).click();
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
