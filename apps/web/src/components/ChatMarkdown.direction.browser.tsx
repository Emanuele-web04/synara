// FILE: ChatMarkdown.direction.browser.tsx
// Purpose: Browser regression for per-block bidi direction in the transcript.
// Layer: Vitest browser tests

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";
import "../index.css";

const PERSIAN_PTR =
  "netkeep وقتی یک rule از نوع `*.github.com` را ارزیابی می‌کند، یک رشته را با نام آن جریان مقایسه می‌کند. اگر آن نام از PTR آمده باشد، در واقع داری می‌گویی که هر ترافیکی به هر IP ای می‌رسد.";

const PERSIAN_LIST = [
  "- **Stripe، Linear، GitHub:** حالت خالی معمولاً یک جمله و یک دکمه است.",
  "- **Airbnb و Material Design:** حالت خالی باید کوتاه و عملی باشد، نه آموزشی.",
].join("\n");

const ENGLISH = "The filter drops rows without a price, and the empty state explains why.";

const HEBREW =
  "שלום, זהו פסקה בעברית עם `src/app/layout.tsx` בתוכה, והיא צריכה להיות מיושרת לימין ולא לשמאל.";

const BILINGUAL = [
  "## نمونه ۱ — متن فارسی با کلمات انگلیسی",
  "",
  "رفتم سراغ src/app/layout.tsx و دیدم که provider مربوط به theme داخل RootLayout گذاشته شده. بعد از pnpm install و اجرای dev server، warning مربوط به hydration توی console ظاهر شد و مشکل از useEffect بود که قبل از mount شدن اجرا می‌شد.",
  "",
  "Actually فکر می‌کنم بهتر است اول چند تست اجرا کنیم و بعد نتیجه را ببینیم، چون تغییر زیاد است.",
  "",
  "Here is what I found: the auth middleware runs before the rate limiter, and this paragraph is English so it should stay left aligned while its neighbours read right to left.",
].join("\n");

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

async function renderMessage(text: string) {
  const screen = await render(
    wrap(
      <div style={{ width: 420 }}>
        <ChatMarkdown text={text} cwd={undefined} isStreaming={false} directionMode="auto-blocks" />
      </div>,
    ),
  );
  const root = screen.container.querySelector<HTMLElement>(".chat-markdown");
  if (!root) throw new Error("chat-markdown root missing");
  return { screen, root };
}

function contentEdges(element: Element): { left: number; right: number } {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = Array.from(range.getClientRects());
  if (rects.length === 0) throw new Error(`no line boxes for ${element.tagName}`);
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    right: Math.max(...rects.map((rect) => rect.right)),
  };
}

describe("ChatMarkdown message direction", () => {
  it("keeps a Latin-first Persian paragraph RTL and flush to the right edge", async () => {
    const { screen, root } = await renderMessage(PERSIAN_PTR);

    const paragraph = root.querySelector("p");
    expect(paragraph).not.toBeNull();
    expect(getComputedStyle(paragraph!).direction).toBe("rtl");
    expect(paragraph!.getAttribute("dir")).toBe("rtl");
    expect(
      Math.abs(contentEdges(paragraph!).right - paragraph!.getBoundingClientRect().right),
    ).toBeLessThan(3);

    const code = root.querySelector("code");
    expect(code).not.toBeNull();
    expect(getComputedStyle(code!).direction).toBe("ltr");

    screen.unmount();
  });

  it("keeps Latin-first list items RTL", async () => {
    const { screen, root } = await renderMessage(PERSIAN_LIST);

    const list = root.querySelector("ul");
    const items = Array.from(root.querySelectorAll("li"));
    expect(list).not.toBeNull();
    expect(items).toHaveLength(2);
    expect(list!.getAttribute("dir")).toBe("rtl");
    for (const item of items) {
      expect(getComputedStyle(item).direction).toBe("rtl");
      expect(item.getAttribute("dir")).toBe("rtl");
      expect(Math.abs(contentEdges(item).right - item.getBoundingClientRect().right)).toBeLessThan(
        3,
      );
    }

    screen.unmount();
  });

  it("keeps an English message LTR and flush to the left edge", async () => {
    const { screen, root } = await renderMessage(ENGLISH);

    const paragraph = root.querySelector("p");
    expect(paragraph).not.toBeNull();
    expect(getComputedStyle(paragraph!).direction).toBe("ltr");
    expect(paragraph!.getAttribute("dir")).toBe("ltr");
    expect(
      Math.abs(contentEdges(paragraph!).left - paragraph!.getBoundingClientRect().left),
    ).toBeLessThan(3);

    screen.unmount();
  });

  it("keeps a Hebrew paragraph RTL and flush to the right edge", async () => {
    const { screen, root } = await renderMessage(HEBREW);

    const paragraph = root.querySelector("p");
    expect(paragraph).not.toBeNull();
    expect(getComputedStyle(paragraph!).direction).toBe("rtl");
    expect(paragraph!.getAttribute("dir")).toBe("rtl");
    expect(
      Math.abs(contentEdges(paragraph!).right - paragraph!.getBoundingClientRect().right),
    ).toBeLessThan(3);

    // Latin identifiers inside the Hebrew paragraph stay LTR on their own.
    const code = root.querySelector("code");
    expect(code).not.toBeNull();
    expect(getComputedStyle(code!).direction).toBe("ltr");

    screen.unmount();
  });

  it("ignores automatic link labels but counts authored link text", async () => {
    const { screen, root } = await renderMessage(
      [
        "https://api.example.net/alpha www.example.com/beta build@example.com سلام",
        "[سلام دنیا](https://example.com) English",
        ENGLISH,
      ].join("\n\n"),
    );

    try {
      const paragraphs = Array.from(root.querySelectorAll("p"));
      expect(paragraphs[0]?.querySelectorAll("a")).toHaveLength(3);
      expect(paragraphs.map((paragraph) => getComputedStyle(paragraph).direction)).toEqual([
        "rtl",
        "rtl",
        "ltr",
      ]);
    } finally {
      screen.unmount();
    }
  });

  it("reads a bilingual message block by block", async () => {
    const { screen, root } = await renderMessage(BILINGUAL);

    // The message default only feeds blocks with no letters of their own; each
    // paragraph decides for itself below.
    const persianBlocks = Array.from(root.querySelectorAll('p[dir="rtl"]'));
    const englishBlocks = Array.from(root.querySelectorAll('p[dir="ltr"]'));
    // Both Persian-majority paragraphs, including the one that opens with an
    // English sentence, read right to left.
    expect(persianBlocks).toHaveLength(2);
    expect(englishBlocks).toHaveLength(1);
    for (const block of persianBlocks) {
      expect(
        Math.abs(contentEdges(block).right - block.getBoundingClientRect().right),
      ).toBeLessThan(3);
    }
    for (const block of englishBlocks) {
      expect(Math.abs(contentEdges(block).left - block.getBoundingClientRect().left)).toBeLessThan(
        3,
      );
    }

    screen.unmount();
  });
});
