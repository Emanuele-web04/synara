import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import ChatMarkdown from "./ChatMarkdown";

vi.mock("../lib/localImageUrls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/localImageUrls")>()),
  buildLocalImageUrl: () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#126b42";
    context.fillRect(0, 0, 320, 200);
    context.fillStyle = "white";
    context.font = "20px sans-serif";
    context.fillText("Verified result", 35, 100);
    return canvas.toDataURL("image/png");
  },
}));

it("renders completion proof inline with expand and download controls", async () => {
  await page.viewport(1000, 800);
  const onImageExpand = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mounted = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ width: 600 }}>
        <ChatMarkdown
          cwd="/workspace"
          text={
            "## Completion report\n\nVerified the saved result.\n\n![Saved result](/private/generated_images/browser-proof/thread/result.png)\n\nUntested: production billing."
          }
          onImageExpand={onImageExpand}
        />
      </div>
    </QueryClientProvider>,
  );
  try {
    const image = mounted.getByRole("img", { name: "Saved result" });
    await expect.element(image).toBeVisible();
    await vi.waitFor(() =>
      expect(document.querySelector(".chat-generated-image")?.getAttribute("data-status")).toBe(
        "ready",
      ),
    );
    await mounted.getByRole("button", { name: "Expand generated image" }).click();
    expect(onImageExpand).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));
    await mounted.getByRole("button", { name: "Expand generated image" }).hover();
    await expect
      .element(mounted.getByRole("link", { name: "Download generated image" }))
      .toBeVisible();
    await expect.element(mounted.getByText("Untested: production billing.")).toBeVisible();
  } finally {
    await mounted.unmount();
    queryClient.clear();
  }
});

it("lays out captioned screenshots in a column and adjacent images side by side", async () => {
  await page.viewport(1000, 800);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mounted = await render(
    <QueryClientProvider client={queryClient}>
      <div style={{ width: 760 }} data-testid="image-rows">
        <ChatMarkdown
          cwd="/workspace"
          text={
            "Retry running:\n![First](/private/generated_images/a.png)\n\n" +
            "Both states:\n![Before](/private/generated_images/b.png)\n![After](/private/generated_images/c.png)\nDone."
          }
          onImageExpand={vi.fn()}
        />
      </div>
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => {
      const frames = document.querySelectorAll('.chat-generated-image[data-status="ready"]');
      expect(frames).toHaveLength(3);
    });
    const rect = (name: string) =>
      mounted.getByRole("img", { name }).element().getBoundingClientRect();
    const textRect = (text: string) => {
      const root = mounted.getByTestId("image-rows").element();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const start = node.textContent?.indexOf(text) ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + text.length);
        return range.getBoundingClientRect();
      }
      throw new Error(`Missing text: ${text}`);
    };
    const caption = textRect("Retry running:");
    const pairCaption = textRect("Both states:");
    const trailing = textRect("Done.");

    expect(rect("First").top).toBeGreaterThanOrEqual(caption.bottom);
    expect(rect("First").left).toBeLessThanOrEqual(caption.left + 1);
    expect(rect("Before").top).toBeGreaterThanOrEqual(pairCaption.bottom);
    expect(rect("After").top).toBe(rect("Before").top);
    expect(rect("After").left).toBeGreaterThan(rect("Before").right);
    expect(trailing.top).toBeGreaterThanOrEqual(rect("Before").bottom);
    await page.getByTestId("image-rows").screenshot({ path: "image-rows-proof.png" });
  } finally {
    await mounted.unmount();
    queryClient.clear();
  }
});
