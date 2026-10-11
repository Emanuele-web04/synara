// Oversized fenced blocks retain their source without synchronous highlighting.
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => {
  const highlight = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`);
  return {
    highlight,
    highlighter: Promise.resolve({ codeToHtml: highlight }),
    copy: vi.fn(async (_text: string) => undefined),
  };
});

vi.mock("../lib/syntaxHighlighting", async (original) => ({
  ...(await original<typeof import("../lib/syntaxHighlighting")>()),
  getSyntaxHighlighterPromise: () => seams.highlighter,
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: seams.copy,
  useCopyToClipboard: () => ({ copyToClipboard: seams.copy, isCopied: false }),
}));

import { MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS } from "../lib/syntaxHighlighting";
import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown highlighting size limit", () => {
  it.each([false, true])(
    "keeps oversized source, find and copy intact (streaming=%s)",
    async (isStreaming) => {
      const screen = await render(
        <ChatMarkdown
          text={`\`\`\`javascript\nconst answer = ${isStreaming ? 43 : 42};\n\`\`\``}
          cwd={undefined}
          isStreaming={false}
        />,
      );
      await expect
        .poll(() => seams.highlight.mock.calls.length, { timeout: 5000 })
        .toBeGreaterThan(0);
      seams.highlight.mockClear();
      seams.copy.mockClear();
      const code = `// ${"x".repeat(MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS)}\nneedle final line`;
      await screen.rerender(
        <ChatMarkdown
          text={`\`\`\`javascript\n${code}\n\`\`\``}
          cwd={undefined}
          isStreaming={isStreaming}
          findQuery="needle"
        />,
      );
      await expect
        .poll(
          () =>
            document.querySelector(".chat-markdown-codeblock pre")?.textContent?.trimEnd().length,
        )
        .toBe(code.length);
      expect(seams.highlight.mock.calls.map(([text]) => text.length)).toEqual([]);
      expect(document.querySelector("[data-chat-find-match]")?.textContent).toBe("needle");
      await screen.getByRole("button", { name: "Copy code", exact: true }).click();
      expect(seams.copy.mock.calls[0]?.[0] === `${code}\n`).toBe(true);
      await screen.getByRole("button", { name: "Enable soft wrap", exact: true }).click();
      expect(document.querySelector(".chat-markdown-codeblock")?.getAttribute("data-wrap")).toBe(
        "true",
      );
      await screen.unmount();
    },
  );
});
