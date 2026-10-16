// Owns the HTTP-hosted client execution boundary for agent HTML.
// Native component visuals remain separate from this refusal path.
import "../../index.css";
import { ThreadId, type NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { InlineVisualFrame } from "./InlineVisualFrame";

vi.mock("~/env", () => ({ isElectron: false }));
afterEach(() => vi.unstubAllGlobals());
it("never fetches or executes agent HTML in an HTTP-hosted browser", async () => {
  const getInlineVisual = vi.fn(async () => ({
    visualId: `vis_${"a".repeat(32)}`,
    html: "<script>parent.postMessage({ probeExecuted: true }, '*')</script>",
  }));
  vi.stubGlobal("nativeApi", { orchestration: { getInlineVisual } } as unknown as NativeApi);
  const client = new QueryClient();
  const screen = await render(
    <QueryClientProvider client={client}>
      <InlineVisualFrame
        threadId={ThreadId.makeUnsafe("browser-visual")}
        visual={{
          visualId: `vis_${"a".repeat(32)}`,
          title: "Untrusted document",
          height: 100,
          byteLength: 30,
          sha256: "a".repeat(64),
        }}
      />
    </QueryClientProvider>,
  );
  try {
    expect(getInlineVisual).not.toHaveBeenCalled();
    await expect
      .element(
        screen.getByText(
          "HTML visuals are available in Synara desktop. Use native components in the browser.",
        ),
      )
      .toBeVisible();
    expect(document.querySelector("iframe[data-inline-visual-frame]")).toBeNull();
    expect(getInlineVisual).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
    client.clear();
  }
});
