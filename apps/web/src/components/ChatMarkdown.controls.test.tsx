// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import ChatMarkdown from "./ChatMarkdown";

const copyTextToClipboardMock = vi.hoisted(() => vi.fn((_text: string) => Promise.resolve()));

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [],
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml(code: string) {
        return `<pre class="shiki"><code>${code}</code></pre>`;
      },
    }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("../hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: copyTextToClipboardMock,
}));

describe("ChatMarkdown code controls", () => {
  it("exposes keyboard-accessible code copy and wrap controls", async () => {
    copyTextToClipboardMock.mockClear();

    await act(async () => {
      render(
        <ChatMarkdown
          text={["```ts", "  const answer = 42;", "```"].join("\n")}
          cwd="/Users/julius/project"
          isStreaming={true}
        />,
      );
    });

    const wrapButton = screen.getByLabelText("Enable soft wrap");
    const copyButton = screen.getByLabelText("Copy code");
    const codeBlock = document.querySelector(".chat-markdown-codeblock");

    expect(wrapButton.getAttribute("aria-pressed")).toBe("false");
    expect(codeBlock?.getAttribute("data-wrap")).toBe("false");

    fireEvent.click(wrapButton);
    expect((await screen.findByLabelText("Disable soft wrap")).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(codeBlock?.getAttribute("data-wrap")).toBe("true");

    fireEvent.click(copyButton);
    await waitFor(() => expect(copyTextToClipboardMock).toHaveBeenCalledTimes(1));
    expect(copyTextToClipboardMock.mock.calls.at(0)?.[0]).toMatch(/^const answer = 42;\n? ?$/);
  }, 10_000);
});
