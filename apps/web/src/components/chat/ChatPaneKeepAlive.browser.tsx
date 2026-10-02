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
    </div>
  );
}

// Two surfaces with unrelated element structures around the slot, like the single chat
// surface and the split view.
function Harness({ splitThreadId = "thread-a" }: { splitThreadId?: string }) {
  const [split, setSplit] = useState(false);
  return (
    <ChatPaneKeepAliveProvider>
      <button type="button" onClick={() => setSplit((current) => !current)}>
        Toggle
      </button>
      {split ? (
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
