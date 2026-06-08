import { readFileSync } from "node:fs";
import { MessageId, ThreadMarkerId, type ThreadMarker } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs", () => ({
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

async function renderMarkdown(
  text: string,
  cwd = "C:\\Users\\LENOVO\\dpcode",
  markers?: readonly ThreadMarker[],
) {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");

  return renderToStaticMarkup(
    <ChatMarkdown text={text} cwd={cwd} isStreaming={false} markers={markers} />,
  );
}

describe("ChatMarkdown", () => {
  it("uses the theme foreground token for markdown text", async () => {
    const markup = await renderMarkdown("Theme-aware text");

    expect(markup).toContain("text-foreground");
    expect(markup).not.toContain("text-neutral-900");
  });

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

  it("renders exact thread marker ranges without changing markdown structure", async () => {
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("marker-1"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset: 7,
      endOffset: 21,
      selectedText: "important text",
      style: "highlight",
      color: "yellow",
      label: null,
      done: false,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const markup = await renderMarkdown("Read **important text** today.", undefined, [marker]);

    expect(markup).toContain('data-thread-marker-id="marker-1"');
    expect(markup).toContain("thread-marker-highlight");
    expect(markup).toContain("<strong>");
    expect(markup).toContain("important text");
  });

  it("renders marker ranges resolved from visual text across markdown delimiters", async () => {
    const text = "**Ho letto tutto il progetto.**\n\n**L'app è bella e curata:** UI dark coerente.";
    const startOffset = text.indexOf("Ho letto");
    const endOffset = text.indexOf(":** UI") + 1;
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("marker-markdown-range"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset,
      endOffset,
      selectedText: text.slice(startOffset, endOffset),
      style: "highlight",
      color: "yellow",
      label: null,
      done: false,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const markup = await renderMarkdown(text, undefined, [marker]);

    expect(markup.match(/data-thread-marker-id="marker-markdown-range"/g) ?? []).toHaveLength(2);
    expect(markup).toContain("Ho letto tutto il progetto.");
    expect(markup).toContain("L&#x27;app è bella e curata:");
  });

  it("keeps marker offsets stable after literal dollar protection", async () => {
    const text = "Price $5. Highlight this phrase.";
    const startOffset = text.indexOf("Highlight");
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("marker-dollar"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset,
      endOffset: startOffset + "Highlight this phrase".length,
      selectedText: "Highlight this phrase",
      style: "underline",
      color: "blue",
      label: null,
      done: false,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const markup = await renderMarkdown(text, undefined, [marker]);

    expect(markup).toContain('data-thread-marker-id="marker-dollar"');
    expect(markup).toContain("thread-marker-underline");
    expect(markup).toContain("Price $5.");
  });

  it("keeps marker offsets aligned when an escaped dollar precedes the marker", async () => {
    // `\$` is two raw characters that render as one `$`; the dollar-protection transform must stay
    // length-preserving or every offset after it shifts and the marker wraps the wrong substring.
    const text = "Cost is \\$5 here. Highlight this phrase.";
    const startOffset = text.indexOf("Highlight");
    const selectedText = "Highlight this phrase";
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("marker-escaped-dollar"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset,
      endOffset: startOffset + selectedText.length,
      selectedText,
      style: "underline",
      color: "blue",
      label: null,
      done: false,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const markup = await renderMarkdown(text, undefined, [marker]);

    expect(markup).toContain('data-thread-marker-id="marker-escaped-dollar"');
    expect(markup).toContain(">Highlight this phrase</span>");
    expect(markup).toContain("Cost is $5 here.");
    expect(markup).not.toContain('class="katex"');
  });

  it("keeps plan, diff, and transcript surfaces routed through the shared renderer", () => {
    const planSidebarSource = readFileSync(new URL("./PlanSidebar.tsx", import.meta.url), "utf8");
    const proposedPlanCardSource = readFileSync(
      new URL("./chat/ProposedPlanCard.tsx", import.meta.url),
      "utf8",
    );
    const messagesTimelineSource = readFileSync(
      new URL("./chat/MessagesTimeline.tsx", import.meta.url),
      "utf8",
    );

    expect(planSidebarSource).toContain('import ChatMarkdown from "./ChatMarkdown"');
    expect(planSidebarSource).toContain("<ChatMarkdown");
    expect(proposedPlanCardSource).toContain('import ChatMarkdown from "../ChatMarkdown"');
    expect(proposedPlanCardSource).toContain("<ChatMarkdown");
    expect(messagesTimelineSource).toContain('import ChatMarkdown from "../ChatMarkdown"');
    expect(messagesTimelineSource).toContain("<ChatMarkdown");
  });
});
