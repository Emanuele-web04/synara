import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChatMarkdown from "./ChatMarkdown";

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [],
  getFiletypeFromFileName: (fileName: string) => fileName.split(".").pop() ?? "text",
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

function renderStreamingMarkdown(text: string) {
  return renderToStaticMarkup(<ChatMarkdown text={text} cwd="/tmp/synara" isStreaming />);
}

function renderSettledMarkdown(text: string) {
  return renderToStaticMarkup(<ChatMarkdown text={text} cwd="/tmp/synara" isStreaming={false} />);
}

describe("ChatMarkdown streaming boundaries", () => {
  it("keeps streaming code fences on the plain code path", () => {
    const markup = renderStreamingMarkdown(["```ts", "const value = 1"].join("\n"));

    expect(markup).toContain("chat-markdown-codeblock");
    expect(markup).not.toContain("chat-markdown-shiki");
    expect(markup).toContain("const value = 1");
  });

  it("holds markdown-fenced tables as code while streaming and upgrades when settled", () => {
    const source = [
      "```markdown",
      "| File | Status |",
      "| --- | --- |",
      "| app.tsx | changed |",
      "```",
    ].join("\n");

    const streamingMarkup = renderStreamingMarkdown(source);
    expect(streamingMarkup).toContain("chat-markdown-codeblock");
    expect(streamingMarkup).not.toContain("chat-markdown-table-scroll");

    const settledMarkup = renderSettledMarkdown(source);
    expect(settledMarkup).toContain("chat-markdown-table-scroll");
    expect(settledMarkup).toContain("<td>app.tsx</td>");
  });

  it("keeps partial links and images as text while streaming", () => {
    const markup = renderStreamingMarkdown("See [the file](./src/App.tsx and ![alt](");

    expect(markup).toContain("[the file]");
    expect(markup).toContain("![alt](");
    expect(markup).not.toContain("chat-generated-image");
  });

  it("keeps incomplete math delimiters literal while streaming", () => {
    const markup = renderStreamingMarkdown("Inline math $x^2 and block $$\n\\int_0^1");

    expect(markup).toContain("$x^2");
    expect(markup).toContain("$$");
    expect(markup).not.toContain("katex");
  });
});
