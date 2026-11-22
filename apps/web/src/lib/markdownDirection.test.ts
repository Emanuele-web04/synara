import { describe, expect, it } from "vitest";

import { resolveMarkdownTextDirection } from "./markdownDirection";

describe("resolveMarkdownTextDirection", () => {
  it("keeps a Persian paragraph RTL when it starts with a Latin name", () => {
    expect(
      resolveMarkdownTextDirection(
        "netkeep وقتی یک rule را ارزیابی می‌کند، یک رشته را با نام آن جریان مقایسه می‌کند و ادامه می‌دهد.",
      ),
    ).toBe("rtl");
  });

  it("keeps a Persian paragraph RTL when it starts with a bold English label", () => {
    expect(
      resolveMarkdownTextDirection(
        "**Stripe، Linear، GitHub:** حالت خالی معمولاً یک جمله و یک دکمه است.",
      ),
    ).toBe("rtl");
  });

  it("keeps a Persian paragraph RTL when it starts with inline code", () => {
    expect(
      resolveMarkdownTextDirection(
        "`just check` کامل را اجرا نکردم و بررسی مرورگر را انجام ندادم.",
      ),
    ).toBe("rtl");
  });

  it("keeps a Hebrew paragraph RTL, including one that starts with Latin", () => {
    expect(resolveMarkdownTextDirection("שלום עולם, זהו טקסט בעברית עם מילים באנגלית.")).toBe(
      "rtl",
    );
    expect(
      resolveMarkdownTextDirection("netkeep בודק את החיבור ומשווה את השם שהתקבל מול הכלל שהוגדר."),
    ).toBe("rtl");
  });

  it("returns LTR for English prose", () => {
    expect(resolveMarkdownTextDirection("Run `bun run test` before you push the branch.")).toBe(
      "ltr",
    );
  });

  it("ignores fenced code so a big English block cannot flip a Persian message", () => {
    const text = [
      "سلام، این پیام فارسی است و باید راست‌چین بماند.",
      "",
      "```ts",
      "const absolutelyEverything = 'this is a long English line of code to skew the count';",
      "```",
    ].join("\n");

    expect(resolveMarkdownTextDirection(text)).toBe("rtl");
  });

  it("ignores link targets, bare URLs, images and HTML tags", () => {
    const text =
      'سلام [لینک](https://example.com/a/very/long/english/path/that/should/not/count) و https://example.com/another/long/path <span data-x="english words">متن</span> ![](https://example.com/english-image-alt-text.png)';
    expect(resolveMarkdownTextDirection(text)).toBe("rtl");
  });

  it("ignores math", () => {
    expect(resolveMarkdownTextDirection("این فرمول: $x = y + z \\cdot long$ را ببین.")).toBe("rtl");
  });

  it("keeps a Persian sentence RTL when Latin identifiers outnumber its letters", () => {
    expect(
      resolveMarkdownTextDirection(
        "رفتم سراغ src/app/layout.tsx و دیدم که provider مربوط به theme داخل RootLayout گذاشته شده. بعد از pnpm install و اجرای dev server، warning مربوط به hydration توی console ظاهر شد و مشکل از useEffect بود.",
      ),
    ).toBe("rtl");
  });

  it("keeps an English message with one Persian quote LTR", () => {
    expect(
      resolveMarkdownTextDirection(
        "The error says «خطا رخ داد» and the branch is protected, so the push is rejected.",
      ),
    ).toBe("ltr");
  });

  it("falls back to LTR when there are no letters", () => {
    expect(resolveMarkdownTextDirection("123 — !!! `code`")).toBe("ltr");
    expect(resolveMarkdownTextDirection("")).toBe("ltr");
  });
});
