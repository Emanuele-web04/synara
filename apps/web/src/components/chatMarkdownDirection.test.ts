// FILE: chatMarkdownDirection.test.ts
// Purpose: Unit tests for block direction resolution and the rehype direction
// plugin (text/positions/find offsets/hrefs must stay untouched).
import { describe, expect, it } from "vitest";

import {
  isPureTechnicalLinkText,
  rehypeChatBlockDirection,
  resolveBlockDirection,
} from "./chatMarkdownDirection";

interface TestNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TestNode[];
}

const text = (value: string): TestNode => ({ type: "text", value });
const el = (
  tagName: string,
  children: TestNode[],
  properties: Record<string, unknown> = {},
): TestNode => ({
  type: "element",
  tagName,
  properties,
  children,
});
const findText = (value: string, offset: number): TestNode =>
  el("chat-find-text", [text(value)], { "data-chat-find-text-start": String(offset) });

function applyPlugin(tree: TestNode): TestNode {
  const transform = rehypeChatBlockDirection();
  transform(tree as unknown);
  return tree;
}

const dirOf = (node: TestNode): unknown => node.properties?.dir ?? null;
const mixedOf = (node: TestNode): unknown => node.properties?.["data-mixed-direction-list"] ?? null;

describe("resolveBlockDirection", () => {
  it("classifies pure Arabic as rtl", () => {
    expect(resolveBlockDirection("هذا نص عربي خالص للاختبار.")).toBe("rtl");
  });

  it("classifies Arabic led by digits and emoji as rtl (neutrals do not count)", () => {
    expect(resolveBlockDirection("42 مثال عربي بعد رقم.")).toBe("rtl");
    expect(resolveBlockDirection("🚀 هذا مثال عربي بعد إيموجي.")).toBe("rtl");
  });

  it("classifies Arabic-majority text starting with a Latin term as rtl", () => {
    expect(resolveBlockDirection("API إعدادات المشروع بالعربي الغالب هنا.")).toBe("rtl");
  });

  it("classifies Latin-majority text containing an Arabic word as ltr", () => {
    expect(resolveBlockDirection("This English sentence contains the word مرحبا inside.")).toBe(
      "ltr",
    );
  });

  it("classifies Hebrew and Persian as rtl (defensive coverage)", () => {
    expect(resolveBlockDirection("שלום עולם")).toBe("rtl");
    expect(resolveBlockDirection("این یک جمله فارسی است")).toBe("rtl");
  });

  it("classifies pure Latin as ltr", () => {
    expect(resolveBlockDirection("Plain English prose.")).toBe("ltr");
  });

  it("breaks ties with the first strong code point", () => {
    expect(resolveBlockDirection("مرحبا hello")).toBe("rtl");
    expect(resolveBlockDirection("hello مرحبا")).toBe("ltr");
  });

  it("returns null when no strong code point exists", () => {
    expect(resolveBlockDirection("")).toBeNull();
    expect(resolveBlockDirection("123 !!! ...")).toBeNull();
    expect(resolveBlockDirection("🚀🎉")).toBeNull();
  });

  it("treats punctuation and combining marks as neutral", () => {
    expect(resolveBlockDirection("«مثال»")).toBe("rtl");
    expect(resolveBlockDirection("M")).toBe("ltr");
  });

  it("keeps Arabic-script digits, punctuation, and combining marks neutral", () => {
    expect(resolveBlockDirection("١٢٣ ۱۲۳ ؟ َ ِ")).toBeNull();
    expect(resolveBlockDirection("١٢٣ ؟ هذا نص عربي")).toBe("rtl");
  });
});

describe("isPureTechnicalLinkText", () => {
  it("flags bare URL autolinks as technical", () => {
    expect(isPureTechnicalLinkText("https://example.com/docs", "https://example.com/docs")).toBe(
      true,
    );
    expect(isPureTechnicalLinkText("example.com", "https://example.com")).toBe(true);
  });

  it("flags scheme URLs and paths as technical", () => {
    expect(isPureTechnicalLinkText("https://example.com/a", undefined)).toBe(true);
    expect(isPureTechnicalLinkText("mailto:a@b.c", undefined)).toBe(true);
    expect(isPureTechnicalLinkText("src/main.ts", undefined)).toBe(true);
    expect(isPureTechnicalLinkText("./notes.md", undefined)).toBe(true);
    expect(isPureTechnicalLinkText("C:\\Users\\x\\file.ts", undefined)).toBe(true);
  });

  it("flags whitespace-free file names with an extension as technical", () => {
    expect(isPureTechnicalLinkText("notes.md", undefined)).toBe(true);
    expect(isPureTechnicalLinkText("v1.2", undefined)).toBe(true);
  });

  it("keeps human labels non-technical", () => {
    expect(isPureTechnicalLinkText("رابط التوثيق", "https://example.com/docs")).toBe(false);
    expect(isPureTechnicalLinkText("Read more here", "https://example.com/docs")).toBe(false);
    expect(isPureTechnicalLinkText("التوثيق", "file:///docs.md")).toBe(false);
    expect(isPureTechnicalLinkText("", "https://example.com")).toBe(false);
  });
});

describe("rehypeChatBlockDirection", () => {
  it("sets rtl on an Arabic paragraph and leaves text untouched", () => {
    const tree = el("p", [findText("هذا نص عربي خالص للاختبار.", 3)]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("rtl");
    expect(tree.children?.[0]?.properties?.["data-chat-find-text-start"]).toBe("3");
    expect(tree.children?.[0]?.children?.[0]?.value).toBe("هذا نص عربي خالص للاختبار.");
  });

  it("sets ltr on a Latin-majority paragraph", () => {
    const tree = el("p", [text("This English sentence contains the word مرحبا inside.")]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("ltr");
  });

  it("keeps paragraphs with no strong code point direction-less", () => {
    const tree = el("p", [text("123 !!! ...")]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBeNull();
  });

  it("excludes inline code from the majority and forces code ltr", () => {
    const tree = el("p", [
      findText("الملف الرئيسي ", 0),
      el("code", [text("src/main.ts")]),
      findText(" بالعربي.", 15),
    ]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("rtl");
    expect(dirOf(tree.children![1]!)).toBe("ltr");
  });

  it("forces pre and its code ltr without affecting surrounding paragraph", () => {
    const tree = el("div", [
      el("p", [text("الشرح بالعربي.")]),
      el("pre", [el("code", [text("const x = 1;")])]),
    ]);
    applyPlugin(tree);
    expect(dirOf(tree.children![0]!)).toBe("rtl");
    expect(dirOf(tree.children![1]!)).toBe("ltr");
    expect(dirOf(tree.children![1]!.children![0]!)).toBe("ltr");
  });

  it("keeps table geometry ltr and gives cells their own directions", () => {
    const tree = el("table", [
      el("thead", [el("tr", [el("th", [text("عمود")]), el("th", [text("Column")])])]),
      el("tbody", [el("tr", [el("td", [text("خلية")]), el("td", [text("cell")])])]),
    ]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("ltr");
    expect(dirOf(tree.children![0]!.children![0]!.children![0]!)).toBe("rtl");
    expect(dirOf(tree.children![0]!.children![0]!.children![1]!)).toBe("ltr");
    expect(dirOf(tree.children![1]!.children![0]!.children![0]!)).toBe("rtl");
    expect(dirOf(tree.children![1]!.children![0]!.children![1]!)).toBe("ltr");
  });

  it("gives tight list items their own direct text direction", () => {
    const tree = el("ul", [el("li", [text("عنصر عربي")]), el("li", [text("English item")])]);
    applyPlugin(tree);
    expect(dirOf(tree.children![0]!)).toBe("rtl");
    expect(dirOf(tree.children![1]!)).toBe("ltr");
  });

  it("gives loose list items the direction of their first paragraph", () => {
    const tree = el("ul", [
      el("li", [el("p", [text("فقرة عربية أولى")]), el("p", [text("second English paragraph")])]),
    ]);
    applyPlugin(tree);
    const li = tree.children![0]!;
    expect(dirOf(li)).toBe("rtl");
    expect(dirOf(li.children![0]!)).toBe("rtl");
    expect(dirOf(li.children![1]!)).toBe("ltr");
  });

  it("marks mixed-direction lists and leaves uniform lists unmarked", () => {
    const mixed = el("ul", [el("li", [text("عنصر عربي")]), el("li", [text("English item")])]);
    applyPlugin(mixed);
    expect(mixedOf(mixed)).toBe("true");
    expect(dirOf(mixed)).toBeNull();

    const uniform = el("ol", [el("li", [text("عنصر أول")]), el("li", [text("عنصر ثانٍ")])]);
    applyPlugin(uniform);
    expect(mixedOf(uniform)).toBeNull();
    expect(dirOf(uniform)).toBe("rtl");

    const ltr = el("ul", [el("li", [text("First item")]), el("li", [text("Second item")])]);
    applyPlugin(ltr);
    expect(mixedOf(ltr)).toBeNull();
    expect(dirOf(ltr)).toBeNull();
  });

  it("forces composer and terminal chips ltr without counting them as prose", () => {
    const tree = el("p", [
      text("راجع المسار التالي "),
      el("composer-chip", []),
      el("terminal-context-chip", []),
    ]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("rtl");
    expect(dirOf(tree.children![1]!)).toBe("ltr");
    expect(dirOf(tree.children![2]!)).toBe("ltr");
  });

  it("isolates bare URL links ltr and excludes them from the parent majority", () => {
    const tree = el("p", [
      el("a", [text("https://example.com/docs")], { href: "https://example.com/docs" }),
    ]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBeNull();
    expect(dirOf(tree.children![0]!)).toBe("ltr");
  });

  it("keeps human-labeled links inheriting and counting toward the majority", () => {
    const tree = el("p", [
      findText("اقرأ ", 0),
      el("a", [text("رابط التوثيق")], { href: "https://example.com/docs" }),
    ]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("rtl");
    expect(dirOf(tree.children![1]!)).toBeNull();
    expect(tree.children![1]!.properties?.href).toBe("https://example.com/docs");
  });

  it("isolates KaTeX as ltr and excludes it from the paragraph majority", () => {
    const tree = el("p", [
      findText("المعادلة ", 0),
      el("span", [text("x^2")], { className: ["katex"] }),
      findText(" بالعربي.", 10),
    ]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("rtl");
    expect(dirOf(tree.children![1]!)).toBe("ltr");
  });

  it("sets blockquote direction from its collected human text", () => {
    const tree = el("blockquote", [el("p", [text("اقتباس عربي هنا")])]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("rtl");
    expect(dirOf(tree.children![0]!)).toBe("rtl");
  });

  it("sets headings with Arabic majority rtl", () => {
    const tree = el("h2", [text("عنوان عربي")]);
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("rtl");
  });

  it("preserves task list item classes and directions", () => {
    const tree = el("li", [el("input", [], { type: "checkbox" }), text("مهمة عربية")], {
      className: ["task-list-item"],
    });
    applyPlugin(tree);
    expect(dirOf(tree)).toBe("rtl");
    expect(tree.properties?.className).toEqual(["task-list-item"]);
  });

  it("never modifies text values, positions, find offsets, or hrefs", () => {
    const tree = el("div", [
      el("p", [
        findText("نص عربي مع ", 0),
        el("a", [text("https://example.com")], { href: "https://example.com" }),
        el("code", [text("x")]),
      ]),
    ]);
    const before = JSON.stringify(tree);
    applyPlugin(tree);
    expect(tree.children?.[0]?.children?.[0]?.children?.[0]?.value).toBe("نص عربي مع ");
    expect(tree.children?.[0]?.children?.[0]?.properties?.["data-chat-find-text-start"]).toBe("0");
    expect(tree.children?.[0]?.children?.[1]?.properties?.href).toBe("https://example.com");
    expect(tree.children?.[0]?.children?.[1]?.children?.[0]?.value).toBe("https://example.com");
    const after = JSON.stringify(tree);
    expect(after).toContain('"value":"نص عربي مع "');
    expect(before.length).toBeLessThan(after.length);
  });

  it("computes nested blocks independently", () => {
    const tree = el("blockquote", [
      el("p", [text("فقرة عربية")]),
      el("p", [text("English paragraph")]),
    ]);
    applyPlugin(tree);
    expect(dirOf(tree.children![0]!)).toBe("rtl");
    expect(dirOf(tree.children![1]!)).toBe("ltr");
  });
});
