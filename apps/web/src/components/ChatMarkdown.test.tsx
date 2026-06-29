import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

const chatMarkdownModulePromise = import("./ChatMarkdown");

async function renderMarkdown(text: string, cwd = "C:\\Users\\LENOVO\\dpcode") {
  const { default: ChatMarkdown } = await chatMarkdownModulePromise;

  return renderToStaticMarkup(<ChatMarkdown text={text} cwd={cwd} isStreaming={false} />);
}

async function renderMarkdownWithHtml(text: string, cwd = "/Users/julius/project") {
  const { default: ChatMarkdown } = await chatMarkdownModulePromise;

  return renderToStaticMarkup(<ChatMarkdown text={text} cwd={cwd} isStreaming={false} allowHtml />);
}

describe("ChatMarkdown", () => {
  it("uses the theme foreground token for markdown text", async () => {
    const markup = await renderMarkdown("Theme-aware text");

    expect(markup).toContain("text-foreground");
    expect(markup).not.toContain("text-neutral-900");
  }, 15_000);

  it("renders inline math with KaTeX", async () => {
    const markup = await renderMarkdown("Euler wrote $e^{i\\\\pi} + 1 = 0$.");

    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain("katex-display");
    expect(markup).not.toContain("$e^{i\\\\pi} + 1 = 0$");
  });

  it("renders display math with KaTeX block output", async () => {
    const markup = await renderMarkdown("$$\n\\\\int_0^1 x^2 \\, dx\n$$");

    expect(markup).toContain("katex-display");
    expect(markup).not.toContain("$$");
  });

  it("keeps links and code intact when math is present", async () => {
    const markup = await renderMarkdown(
      [
        "Read [local notes](./notes.md) and [external docs](https://example.com).",
        "",
        "Inline math $x^2 + y^2$ still renders.",
        "",
        "Inline code `$z$` stays literal.",
        "",
        "```ts",
        'const price = "$5";',
        "```",
      ].join("\n"),
    );

    expect(markup).toContain('href="./notes.md"');
    expect(markup).not.toContain('href="./notes.md" target="_blank"');
    expect(markup).toContain(
      'href="https://example.com" target="_blank" rel="noopener noreferrer"',
    );
    expect(markup).toContain("<code>$z$</code>");
    expect(markup).toContain("const price = &quot;$5&quot;;");
    expect(markup.match(/class="katex"/g) ?? []).toHaveLength(1);
  });

  it("keeps dollar signs in markdown file links from becoming math", async () => {
    const source =
      "Files touched:\n\n- [_chat.$threadId.tsx](/Users/julius/project/apps/web/src/routes/_chat.$threadId.tsx:1192)";
    const markup = await renderMarkdown(source, "/Users/julius/project");

    expect(markup).toContain(
      'href="/Users/julius/project/apps/web/src/routes/_chat.$threadId.tsx:1192"',
    );
    expect(markup).toContain("_chat.$threadId.tsx");
    expect(markup).not.toContain('class="katex"');
    expect(markup).not.toContain("CHATMARKDOWNLITERALDOLLARPLACEHOLDER");
  });

  it("renders local file-link chips from the resolved target instead of arbitrary labels", async () => {
    const markup = await renderMarkdown(
      "Read [not the path](./src/components/ChatMarkdown.tsx:12).",
      "/Users/tylersheffield/code/synara/apps/web",
    );

    expect(markup).toContain("ChatMarkdown.tsx");
    expect(markup).not.toContain("not the path");
    expect(markup).toContain('href="./src/components/ChatMarkdown.tsx:12"');
  });

  it("does not turn ordinary dollar text or escaped dollars into math", async () => {
    const markup = await renderMarkdown(
      "It costs $5 to $10 per seat. Escape \\$E=mc^2\\$ when you want literal TeX.",
    );

    expect(markup).toContain("$5 to $10");
    expect(markup).toContain("$E=mc^2$");
    expect(markup).not.toContain('class="katex"');
  });

  it("keeps currency literal without swallowing later inline math", async () => {
    const markup = await renderMarkdown("Price $5. Formula $x$ still renders.");

    expect(markup).toContain("$5. Formula");
    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain("$x$");
  });

  it("keeps all-caps dollar identifiers literal", async () => {
    const markup = await renderMarkdown("Use $USD$ for price and $PATH$ for shell lookup.");

    expect(markup).toContain("$USD$");
    expect(markup).toContain("$PATH$");
    expect(markup).not.toContain('class="katex"');
  });

  it("routes mermaid fences through the diagram renderer", async () => {
    const markup = await renderMarkdown(
      ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n"),
    );

    expect(markup).toContain('data-chat-mermaid="pending"');
    expect(markup).not.toContain("chat-markdown-codeblock");
  });

  it("escapes raw HTML by default instead of rendering it", async () => {
    const markup = await renderMarkdown(
      "<details><summary>1 Skipped Deployment</summary>body</details>",
    );

    expect(markup).not.toContain("<details>");
    expect(markup).toContain("&lt;details&gt;");
  });

  it("renders the GitHub HTML subset when allowHtml is set", async () => {
    const markup = await renderMarkdownWithHtml(
      "<details><summary>1 Skipped Deployment</summary>The body</details>",
    );

    expect(markup).toContain("<details>");
    expect(markup).toContain("<summary>1 Skipped Deployment</summary>");
    expect(markup).toContain("The body");
  });

  it("strips scripts and event handlers from allowed HTML", async () => {
    const markup = await renderMarkdownWithHtml(
      '<a href="https://example.com" onclick="steal()">link</a><script>evil()</script>',
    );

    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("onclick");
    expect(markup).not.toContain("evil()");
    expect(markup).toContain('href="https://example.com"');
  });

  it("sanitizes unsafe HTML protocols, style attributes, and SVG script content", async () => {
    const markup = await renderMarkdownWithHtml(
      [
        '<a href="javascript:alert(1)">bad protocol</a>',
        '<img src="x" onerror="steal()" style="width:999px">',
        '<span style="color:red">styled</span>',
        "<svg><script>evil()</script><foreignObject>bad</foreignObject></svg>",
      ].join(""),
    );

    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("onerror");
    expect(markup).not.toContain("style=");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("foreignObject");
    expect(markup).not.toContain("evil()");
    expect(markup).toContain("bad protocol");
    expect(markup).toContain("styled");
  });

  it("keeps KaTeX math working alongside sanitized HTML", async () => {
    const markup = await renderMarkdownWithHtml(
      ["<details><summary>Notes</summary>collapsible</details>", "", "Inline $x^2$ renders."].join(
        "\n",
      ),
    );

    expect(markup).toContain("<details>");
    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain("$x^2$");
  });

  it("renders markdown-fenced tables as contained tables", async () => {
    const markup = await renderMarkdown(
      ["```markdown", "| File | Status |", "| --- | --- |", "| app.tsx | changed |", "```"].join(
        "\n",
      ),
    );

    expect(markup).toContain('class="chat-markdown-table-scroll"');
    expect(markup).toContain("<table>");
    expect(markup).toContain("<td>app.tsx</td>");
    expect(markup).not.toContain("chat-markdown-codeblock");
  });

  it("renders markdown-fenced tables after intro text", async () => {
    const markup = await renderMarkdown(
      [
        "```md",
        "Here is the table:",
        "",
        "| File | Status |",
        "| --- | --- |",
        "| app.tsx | changed |",
        "```",
      ].join("\n"),
    );

    expect(markup).toContain('class="chat-markdown-table-scroll"');
    expect(markup).toContain("<table>");
    expect(markup).toContain("<td>app.tsx</td>");
    expect(markup).not.toContain("chat-markdown-codeblock");
  });

  it("detects blockquoted markdown-fenced tables", async () => {
    const markup = await renderMarkdown(
      [
        "```markdown",
        "> | File | Status |",
        "> | --- | --- |",
        "> | app.tsx | changed |",
        "```",
      ].join("\n"),
    );

    expect(markup).toContain('class="chat-markdown-table-scroll"');
    expect(markup).toContain("<table>");
    expect(markup).toContain("<td>app.tsx</td>");
  });

  it("wraps regular markdown tables in the transcript overflow shell", async () => {
    const markup = await renderMarkdown(
      ["| Package | Version |", "| --- | --- |", "| @t3tools/web | 1.0.0 |"].join("\n"),
    );

    expect(markup).toContain('class="chat-markdown-table-scroll"');
    expect(markup).toContain("<table>");
    expect(markup).toContain("<td>@t3tools/web</td>");
  });

  it("routes local markdown images through generated-image chrome", async () => {
    const markup = await renderMarkdown("![local alt](./image.png)", "/Users/julius/project");

    expect(markup).toContain('class="chat-generated-image"');
    expect(markup).toContain('alt="local alt"');
    expect(markup).toContain("/local-image?");
    expect(markup).toContain("path=.%2Fimage.png");
    expect(markup).toContain("cwd=%2FUsers%2Fjulius%2Fproject");
  });

  it("keeps external markdown images as lazy img elements", async () => {
    const markup = await renderMarkdown("![external alt](https://example.com/a.png)");

    expect(markup).toContain('<img src="https://example.com/a.png"');
    expect(markup).toContain('alt="external alt"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).not.toContain("chat-generated-image");
  });

  it("defines compact chat heading, quote, table, and code-control selectors", () => {
    const cssSource = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    expect(cssSource).toContain(".chat-markdown h1,");
    expect(cssSource).toContain(".chat-markdown h6");
    expect(cssSource).toContain(".chat-markdown blockquote");
    expect(cssSource).toContain("color-mix(in srgb, var(--foreground) 88%");
    expect(cssSource).toContain(".chat-markdown .chat-markdown-table-scroll");
    expect(cssSource).toContain(".chat-markdown .chat-markdown-codeblock__action");
  });

  it("keeps plan surfaces routed through the shared renderer", () => {
    const planSidebarSource = readFileSync(new URL("./PlanSidebar.tsx", import.meta.url), "utf8");
    const proposedPlanCardSource = readFileSync(
      new URL("./chat/ProposedPlanCard.tsx", import.meta.url),
      "utf8",
    );

    expect(planSidebarSource).toContain('import ChatMarkdown from "./ChatMarkdown"');
    expect(planSidebarSource).toContain("<ChatMarkdown");
    expect(proposedPlanCardSource).toContain('import ChatMarkdown from "../ChatMarkdown"');
    expect(proposedPlanCardSource).toContain("<ChatMarkdown");
  });
});
