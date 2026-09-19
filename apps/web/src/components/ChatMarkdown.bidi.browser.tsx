// FILE: ChatMarkdown.bidi.browser.tsx
// Purpose: Browser regression for block-level direction mode: computed
// directions, technical LTR isolation, links, geometry, streaming identity,
// clipboard-fidelity and find offsets.
// Layer: Vitest browser tests

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

// Production CSS is part of the behavior under test (geometry assertions).
import "../index.css";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

import ChatMarkdown from "./ChatMarkdown";

const ARABIC_PARAGRAPH = "هذا نص عربي خالص للاختبار.";
const ARABIC_WITH_DIGITS = "42 مثال عربي بعد رقم.";
const ARABIC_WITH_EMOJI = "🚀 هذا مثال عربي بعد إيموجي.";
const API_LED_ARABIC = "API إعدادات المشروع بالعربي الغالب هنا.";
const ENGLISH_WITH_ARABIC_WORD = "This English sentence contains the word مرحبا inside.";

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWithProviders(ui: ReactElement) {
  return render(<QueryClientProvider client={makeQueryClient()}>{ui}</QueryClientProvider>);
}

const firstParagraph = () => document.querySelector<HTMLElement>(".chat-markdown p");
const rootHasDirectionMode = () =>
  document.querySelector(".chat-markdown")?.getAttribute("data-direction-mode") === "auto-blocks";

describe("ChatMarkdown directionMode browser", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a pure Arabic paragraph rtl with start alignment", async () => {
    await renderWithProviders(
      <ChatMarkdown text={ARABIC_PARAGRAPH} cwd={undefined} directionMode="auto-blocks" />,
    );
    const p = firstParagraph()!;
    expect(p.getAttribute("dir")).toBe("rtl");
    expect(getComputedStyle(p).direction).toBe("rtl");
    expect(getComputedStyle(p).textAlign).toBe("start");
    expect(p.textContent).toBe(ARABIC_PARAGRAPH);
  });

  it.each([
    ["digits first", ARABIC_WITH_DIGITS],
    ["emoji first", ARABIC_WITH_EMOJI],
  ])("renders Arabic led by %s rtl", async (_label, text) => {
    await renderWithProviders(
      <ChatMarkdown text={text} cwd={undefined} directionMode="auto-blocks" />,
    );
    expect(firstParagraph()?.getAttribute("dir")).toBe("rtl");
  });

  it("resolves the majority policy for mixed prose", async () => {
    await renderWithProviders(
      <ChatMarkdown text={API_LED_ARABIC} cwd={undefined} directionMode="auto-blocks" />,
    );
    expect(firstParagraph()?.getAttribute("dir")).toBe("rtl");
  });

  it("keeps Latin-majority prose ltr", async () => {
    await renderWithProviders(
      <ChatMarkdown text={ENGLISH_WITH_ARABIC_WORD} cwd={undefined} directionMode="auto-blocks" />,
    );
    expect(firstParagraph()?.getAttribute("dir")).toBe("ltr");
  });

  it("keeps headings rtl and technical islands ltr", async () => {
    await renderWithProviders(
      <ChatMarkdown
        text={`## عنوان عربي\n\nالشرح مع كود \`src/main.ts\` والمعادلة $x^2$ هنا.`}
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );
    const heading = document.querySelector<HTMLElement>(".chat-markdown h2");
    expect(heading?.getAttribute("dir")).toBe("rtl");
    const code = document.querySelector<HTMLElement>(".chat-markdown code");
    expect(code?.getAttribute("dir")).toBe("ltr");
    const katex = document.querySelector<HTMLElement>(".chat-markdown .katex");
    expect(katex?.getAttribute("dir")).toBe("ltr");
    expect(katex ? getComputedStyle(katex).direction : null).toBe("ltr");
  });

  it("keeps tables ltr with per-cell directions", async () => {
    await renderWithProviders(
      <ChatMarkdown
        text={["| عمود | Column |", "| --- | --- |", "| خلية | cell |"].join("\n")}
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );
    const table = document.querySelector<HTMLElement>(".chat-markdown table");
    expect(table?.getAttribute("dir")).toBe("ltr");
    const cells = Array.from(
      document.querySelectorAll<HTMLElement>(".chat-markdown th, .chat-markdown td"),
    );
    expect(cells.map((cell) => cell.getAttribute("dir"))).toEqual(["rtl", "ltr", "rtl", "ltr"]);
  });

  it("renders an Arabic-labeled link inheriting the rtl paragraph", async () => {
    await renderWithProviders(
      <ChatMarkdown
        text="اقرأ [رابط التوثيق](https://example.com/docs) للمزيد."
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );
    const p = firstParagraph()!;
    expect(p.getAttribute("dir")).toBe("rtl");
    const link = p.querySelector<HTMLElement>("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("dir")).toBeNull();
    expect(link ? getComputedStyle(link).direction : null).toBe("rtl");
  });

  it("renders a paragraph containing only an Arabic-labeled link rtl", async () => {
    await renderWithProviders(
      <ChatMarkdown
        text="[رابط التوثيق](https://example.com/docs)"
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );
    const p = firstParagraph()!;
    expect(p.getAttribute("dir")).toBe("rtl");
    const link = p.querySelector<HTMLElement>("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("dir")).toBeNull();
    expect(link ? getComputedStyle(link).direction : null).toBe("rtl");
  });

  it("isolates a bare URL ltr inside an rtl paragraph", async () => {
    await renderWithProviders(
      <ChatMarkdown
        text="الرابط https://example.com/docs هنا."
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );
    const p = firstParagraph()!;
    expect(p.getAttribute("dir")).toBe("rtl");
    const link = p.querySelector<HTMLElement>("a");
    expect(link?.getAttribute("dir")).toBe("ltr");
    expect(link ? getComputedStyle(link).direction : null).toBe("ltr");
  });

  it("keeps wiki links with Arabic labels inheriting direction", async () => {
    await renderWithProviders(
      <ChatMarkdown
        text="راجع [[توثيق|رابط التوثيق]] هنا."
        cwd="/vault"
        wikiLinkRoot="/vault"
        directionMode="auto-blocks"
      />,
    );
    const p = firstParagraph()!;
    expect(p.getAttribute("dir")).toBe("rtl");
    expect(p.textContent).toContain("رابط التوثيق");
  });

  it("keeps source text exactly copyable with no control characters", async () => {
    const text = "الملف الرئيسي `src/main.ts` بالعربي مع رابط https://example.com/docs في النهاية.";
    await renderWithProviders(
      <ChatMarkdown text={text} cwd={undefined} directionMode="auto-blocks" />,
    );
    const p = firstParagraph()!;
    // Rendered text is the source minus markdown syntax (backticks), and must
    // not contain any injected bidi control characters.
    const rendered = p.textContent ?? "";
    expect(rendered).toBe(
      "الملف الرئيسي src/main.ts بالعربي مع رابط https://example.com/docs في النهاية.",
    );
    const hasForbiddenControl = Array.from(rendered).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        codePoint === 0x200e ||
        codePoint === 0x200f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    });
    expect(hasForbiddenControl).toBe(false);
  });

  it("preserves find offsets in direction mode", async () => {
    const text = "الملف الرئيسي `src/main.ts` بالعربي.";
    const startOffset = text.indexOf("الرئيسي");
    await renderWithProviders(
      <ChatMarkdown
        text={text}
        cwd={undefined}
        directionMode="auto-blocks"
        findQuery="الرئيسي"
        findActiveRange={{ startOffset, endOffset: startOffset + 7 }}
      />,
    );
    const match = document.querySelector<HTMLElement>(
      `.chat-markdown [data-chat-find-start="${startOffset}"]`,
    );
    expect(match).not.toBeNull();
    expect(firstParagraph()?.getAttribute("dir")).toBe("rtl");
  });

  it("keeps the root and code block identity stable while streaming", async () => {
    const queryClient = makeQueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ChatMarkdown
          text={"```javascript\nconst answer = 42;\n```\n\nشرح عربي مستمر."}
          cwd={undefined}
          isStreaming
          directionMode="auto-blocks"
        />
      </QueryClientProvider>,
    );
    await screen.getByRole("button", { name: "Enable soft wrap" }).click();
    const root = document.querySelector<HTMLElement>(".chat-markdown");
    const block = document.querySelector<HTMLElement>(".chat-markdown-codeblock");
    expect(block?.getAttribute("data-wrap")).toBe("true");

    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <ChatMarkdown
          text={"```javascript\nconst answer = 42;\n```\n\nشرح عربي مستمر مع جملة جديدة."}
          cwd={undefined}
          isStreaming
          directionMode="auto-blocks"
        />
      </QueryClientProvider>,
    );
    expect(document.querySelector(".chat-markdown")).toBe(root);
    expect(document.querySelector(".chat-markdown-codeblock")).toBe(block);
    expect(block?.getAttribute("data-wrap")).toBe("true");
    expect(root?.getAttribute("data-direction-mode")).toBe("auto-blocks");
    await screen.unmount();
  });

  it("flips task checkbox margins for rtl items", async () => {
    await renderWithProviders(
      <ChatMarkdown text="- [ ] مهمة عربية أولى" cwd={undefined} directionMode="auto-blocks" />,
    );
    const li = document.querySelector<HTMLElement>(".chat-markdown li");
    const checkbox = document.querySelector<HTMLElement>(
      ".chat-markdown .chat-markdown-task-checkbox",
    );
    expect(li?.getAttribute("dir")).toBe("rtl");
    expect(checkbox).not.toBeNull();
    expect(Number.parseFloat(getComputedStyle(checkbox!).marginRight)).toBeLessThan(0);
    expect(Number.parseFloat(getComputedStyle(checkbox!).marginLeft)).toBeGreaterThan(0);
  });

  it("preserves the source line when toggling an rtl task", async () => {
    const onTaskToggle = vi.fn();
    await renderWithProviders(
      <ChatMarkdown
        text={"مقدمة عربية\n\n- [ ] مهمة عربية أولى"}
        cwd={undefined}
        directionMode="auto-blocks"
        onTaskToggle={onTaskToggle}
      />,
    );
    await page.getByRole("checkbox").click();
    expect(onTaskToggle).toHaveBeenCalledWith({ sourceLine: 3, checked: true });
  });

  it("keeps mixed lists readable with inside markers for rtl items", async () => {
    await renderWithProviders(
      <ChatMarkdown
        text={"- عنصر عربي\n- English item\n- عنصر عربي آخر"}
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );
    const list = document.querySelector<HTMLElement>(".chat-markdown ul");
    expect(list?.getAttribute("data-mixed-direction-list")).toBe("true");
    const items = Array.from(document.querySelectorAll<HTMLElement>(".chat-markdown ul > li"));
    expect(items.map((item) => item.getAttribute("dir"))).toEqual(["rtl", "ltr", "rtl"]);
    expect(getComputedStyle(items[0]!).listStylePosition).toBe("inside");
    expect(getComputedStyle(items[1]!).listStylePosition).toBe("outside");
  });

  it("gives uniform rtl lists a right-side gutter at every target width", async () => {
    for (const width of [360, 768, 1440]) {
      await page.viewport(width, 900);
      await renderWithProviders(
        <ChatMarkdown
          text={"- عنصر عربي أول\n- عنصر عربي ثانٍ"}
          cwd={undefined}
          directionMode="auto-blocks"
        />,
      );
      const list = document.querySelector<HTMLElement>(".chat-markdown ul");
      const style = getComputedStyle(list!);
      expect(list?.getAttribute("dir")).toBe("rtl");
      expect(Number.parseFloat(style.paddingLeft)).toBe(0);
      expect(Number.parseFloat(style.paddingRight)).toBeGreaterThan(0);
      expect(getComputedStyle(list!.querySelector("li")!).listStylePosition).toBe("outside");
      document.body.innerHTML = "";
    }
  });

  it("flips blockquote geometry for rtl", async () => {
    await renderWithProviders(
      <ChatMarkdown text="> اقتباس عربي هنا" cwd={undefined} directionMode="auto-blocks" />,
    );
    const quote = document.querySelector<HTMLElement>(".chat-markdown blockquote");
    expect(quote?.getAttribute("dir")).toBe("rtl");
    const style = getComputedStyle(quote!);
    expect(style.borderRightWidth).not.toBe("0px");
    expect(style.borderLeftWidth).toBe("0px");
  });

  it("keeps geometry stable across viewport widths", async () => {
    for (const width of [360, 768, 1440]) {
      await page.viewport(width, 900);
      await renderWithProviders(
        <ChatMarkdown
          text={[
            "- عنصر عربي",
            "- English item",
            "",
            "> اقتباس عربي هنا",
            "",
            "| عمود | Column |",
            "| --- | --- |",
            "| خلية | cell |",
            "",
            "فقرة عربية خالصة للاختبار.",
          ].join("\n")}
          cwd={undefined}
          directionMode="auto-blocks"
        />,
      );
      const table = document.querySelector<HTMLElement>(".chat-markdown table");
      expect(table?.getAttribute("dir")).toBe("ltr");
      const firstRtlItem = document.querySelector<HTMLElement>(".chat-markdown li[dir='rtl']");
      expect(firstRtlItem).not.toBeNull();
      const quote = document.querySelector<HTMLElement>(".chat-markdown blockquote");
      expect(getComputedStyle(quote!).borderRightWidth).not.toBe("0px");
      document.body.innerHTML = "";
    }
  });

  it("stays off for default consumers (no direction attributes)", async () => {
    await renderWithProviders(<ChatMarkdown text={ARABIC_PARAGRAPH} cwd={undefined} />);
    const root = document.querySelector<HTMLElement>(".chat-markdown");
    expect(root?.getAttribute("data-direction-mode")).toBeNull();
    expect(root?.querySelector("[dir]")).toBeNull();
  });

  it("keeps the user variant directional too", async () => {
    await renderWithProviders(
      <ChatMarkdown
        text={ARABIC_PARAGRAPH}
        cwd={undefined}
        variant="user"
        directionMode="auto-blocks"
      />,
    );
    const p = firstParagraph()!;
    expect(p.getAttribute("dir")).toBe("rtl");
    expect(rootHasDirectionMode()).toBe(true);
  });
});
