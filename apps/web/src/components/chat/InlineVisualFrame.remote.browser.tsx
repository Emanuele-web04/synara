import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { InlineVisualFrame } from "./InlineVisualFrame";

const remote = vi.hoisted(() => ({ getInlineVisual: vi.fn() }));
// Remote workspace code has no preload bridge; only its controller is desktop.
vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/lib/hosts/workspaceFrame", async (original) => ({
  ...(await original<typeof import("~/lib/hosts/workspaceFrame")>()),
  readWorkspaceFrame: () => ({ controller: { desktop: true } }),
}));
vi.mock("~/nativeApi", async (original) => ({
  ...(await original<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({ orchestration: remote }),
}));

it("renders HTML inside a desktop-controlled remote workspace without a native bridge", async () => {
  const threadId = ThreadId.makeUnsafe("remote-visual-thread");
  const visualId = `vis_${"c".repeat(32)}`;
  remote.getInlineVisual.mockResolvedValue({
    visualId,
    html: `<div style="height:280px">Remote diagram</div><script>
      let access; try { access = typeof parent.document; } catch (error) { access = error.name; }
      parent.postMessage({probe:"remote-visual",access},"*");
    </script>`,
  });
  const workspace = document.createElement("iframe");
  workspace.title = "Remote workspace";
  document.body.appendChild(workspace);
  const messages: unknown[] = [];
  const record = (event: MessageEvent) => messages.push(event.data);
  workspace.contentWindow!.addEventListener("message", record);
  const client = new QueryClient();
  let unmount: (() => Promise<void>) | undefined;
  try {
    const screen = await render(
      <QueryClientProvider client={client}>
        {createPortal(
          <InlineVisualFrame
            threadId={threadId}
            visual={{
              visualId,
              title: "Remote diagram",
              height: 100,
              byteLength: 100,
              sha256: "c".repeat(64),
            }}
          />,
          workspace.contentDocument!.body,
        )}
      </QueryClientProvider>,
    );
    unmount = () => screen.unmount();
    await expect
      .poll(() => messages)
      .toContainEqual({ probe: "remote-visual", access: "SecurityError" });
    const frame = workspace.contentDocument!.querySelector<HTMLIFrameElement>(
      "iframe[data-inline-visual-frame]",
    )!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(remote.getInlineVisual).toHaveBeenCalledExactlyOnceWith({ threadId, visualId });
  } finally {
    await unmount?.();
    client.clear();
    workspace.contentWindow!.removeEventListener("message", record);
    workspace.remove();
    remote.getInlineVisual.mockReset();
  }
});
