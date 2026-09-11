// FILE: ChatMarkdown.bidi.browser.tsx
// Purpose: Browser regressions for native RTL/LTR ownership in transcript markdown.
// Layer: Web component browser tests

import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessageId, ThreadMarkerId, type ThreadMarker } from "@synara/contracts";

import "../index.css";
import ChatMarkdown from "./ChatMarkdown";

function markdownRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>(
    '.chat-markdown[data-direction-mode="auto-blocks"]',
  );
  if (!root) {
    throw new Error("automatic-direction markdown root was not rendered");
  }
  return root;
}

describe("ChatMarkdown automatic block direction", () => {
  it.each([
    ["مرحبا **بكم** اليوم", "rtl"],
    ["Welcome **back** today", "ltr"],
  ])("joins real highlight fragments in %s", async (text, direction) => {
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("bidi-fragments"),
      messageId: MessageId.makeUnsafe("assistant-bidi"),
      startOffset: 0,
      endOffset: text.length,
      selectedText: text,
      style: "highlight",
      color: "yellow",
      label: null,
      done: false,
      createdAt: "2026-03-17T19:12:28.000Z",
      updatedAt: "2026-03-17T19:12:28.000Z",
    };
    await render(
      <ChatMarkdown
        text={text}
        cwd={undefined}
        directionMode="auto-blocks"
        findQuery={text}
        markers={[marker]}
      />,
    );
    const root = markdownRoot();
    expect(getComputedStyle(root.querySelector("p")!).direction).toBe(direction);
    for (const selector of [".chat-find-match", ".thread-marker-highlight"]) {
      const parts = Array.from(root.querySelectorAll(selector));
      expect(parts).toHaveLength(3);
      const first = getComputedStyle(parts[0]!);
      const last = getComputedStyle(parts[2]!);
      expect(first.paddingInlineStart).not.toBe("0px");
      expect(first.paddingInlineEnd).toBe("0px");
      expect(last.paddingInlineStart).toBe("0px");
      expect(last.paddingInlineEnd).not.toBe("0px");
      expect(first.borderEndEndRadius).toBe("0px");
      expect(last.borderStartStartRadius).toBe("0px");
      expect(parts[0]!.getBoundingClientRect().left < parts[2]!.getBoundingClientRect().left).toBe(
        direction === "ltr",
      );
    }
  });

  it("excludes leading math and code from prose direction", async () => {
    await render(
      <ChatMarkdown
        text={"`npm test` ثم العربية\n\n$x^2$ ثم العربية"}
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );
    const root = markdownRoot();
    expect(
      Array.from(root.querySelectorAll(":scope > p"), (p) => getComputedStyle(p).direction),
    ).toEqual(["rtl", "rtl"]);
    expect(root.querySelector(".katex")?.getAttribute("dir")).toBe("ltr");
  });

  it("preserves table columns inside actual RTL quotes and list items", async () => {
    await render(
      <ChatMarkdown
        text={[
          "> اقتباس عربي",
          ">",
          "> | الأول | Second |",
          "> | --- | --- |",
          "> | قيمة | value |",
          "",
          "- عنصر عربي",
          "",
          "  | الأول | Second |",
          "  | --- | --- |",
          "  | قيمة | value |",
        ].join("\n")}
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );
    const root = markdownRoot();
    for (const selector of ["blockquote", "li"]) {
      const owner = root.querySelector<HTMLElement>(selector)!;
      expect(getComputedStyle(owner).direction).toBe("rtl");
      const table = owner.querySelector("table")!;
      expect(table.getAttribute("dir")).toBe("ltr");
      const cells = table.querySelectorAll("th");
      expect(cells[0]!.getBoundingClientRect().left).toBeLessThan(
        cells[1]!.getBoundingClientRect().left,
      );
      expect(Array.from(cells, (cell) => getComputedStyle(cell).direction)).toEqual(["rtl", "ltr"]);
    }
  });

  it("keeps mixed task checkboxes inside narrow list gutters and toggles the source line", async () => {
    const onTaskToggle = vi.fn();
    const screen = await render(
      <div style={{ width: 240 }}>
        <ChatMarkdown
          text={"- [ ] مهمة عربية\n- [ ] English task\n- [ ] مهمة أخرى"}
          cwd={undefined}
          directionMode="auto-blocks"
          onTaskToggle={onTaskToggle}
        />
      </div>,
    );
    const root = markdownRoot();
    const bounds = root.getBoundingClientRect();
    const items = Array.from(root.querySelectorAll("li"));
    expect(items.map((li) => getComputedStyle(li).direction)).toEqual(["rtl", "ltr", "rtl"]);
    for (const item of items) {
      const checkbox = item.querySelector("input")!.getBoundingClientRect();
      expect(checkbox.left).toBeGreaterThanOrEqual(bounds.left);
      expect(checkbox.right).toBeLessThanOrEqual(bounds.right);
    }
    await screen.getByRole("checkbox").nth(2).click();
    expect(onTaskToggle).toHaveBeenCalledWith({ sourceLine: 3, checked: true });
  });

  it("preserves Arabic wiki labels and real find/marker fragments", async () => {
    const text = "راجع [[My %20 note|مرجع عربي]] ثم **كلام** عربي";
    const startOffset = text.indexOf("مرجع");
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("bidi-alias"),
      messageId: MessageId.makeUnsafe("assistant-bidi"),
      startOffset,
      endOffset: startOffset + "مرجع عربي".length,
      selectedText: "مرجع عربي",
      createdAt: "2026-03-17T19:12:28.000Z",
      color: "yellow",
      style: "highlight",
      label: null,
      done: false,
      updatedAt: "2026-03-17T19:12:28.000Z",
    };
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatMarkdown
          text={text}
          cwd="/vault/nested"
          wikiLinkRoot="/vault"
          directionMode="auto-blocks"
          findQuery="مرجع عربي"
          markers={[marker]}
        />
      </QueryClientProvider>,
    );
    const root = markdownRoot();
    const label = root.querySelector("a bdi[dir=auto]")!;
    expect(getComputedStyle(label).direction).toBe("rtl");
    expect(label.textContent).toBe("مرجع عربي");
    expect(label.closest("a")?.getAttribute("href")).toBe("/vault/My%20%2520%20note.md");
    expect(
      label.querySelector("[data-chat-find-start]")?.getAttribute("data-chat-find-start"),
    ).toBe(String(startOffset));
    expect(label.querySelector("[data-thread-marker-id]")).not.toBeNull();
  });

  it("uses each top-level prose block's first strong character", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          "مرحبا بالعالم\n\nEnglish paragraph\n\n1234 بدون حرف لاتيني\n\n1234 — !!!\n\nAPI هذا شرح"
        }
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );

    const root = markdownRoot();
    const paragraphs = Array.from(root.querySelectorAll("p"));
    expect(root.getAttribute("dir")).toBeNull();
    expect(paragraphs.map((paragraph) => paragraph.getAttribute("dir"))).toEqual([
      "auto",
      "auto",
      "auto",
      "auto",
      "auto",
    ]);
    expect(paragraphs.map((paragraph) => getComputedStyle(paragraph).direction)).toEqual([
      "rtl",
      "ltr",
      "rtl",
      "ltr",
      "ltr",
    ]);

    await screen.unmount();
  });

  it("keeps nested owners independent and preserves table column order", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "> اقتباس عربي",
          "",
          "- عنصر عربي",
          "- English item",
          "",
          "| العربية | English |",
          "| --- | --- |",
          "| قيمة | value |",
        ].join("\n")}
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );

    const root = markdownRoot();
    const quote = root.querySelector<HTMLElement>("blockquote");
    const items = Array.from(root.querySelectorAll<HTMLElement>("li"));
    const table = root.querySelector<HTMLTableElement>("table");
    const firstRowCells = Array.from(root.querySelectorAll<HTMLTableCellElement>("thead th"));

    expect(quote?.getAttribute("dir")).toBe("auto");
    expect(getComputedStyle(quote!).direction).toBe("rtl");
    expect(items.map((item) => getComputedStyle(item).direction)).toEqual(["rtl", "ltr"]);
    expect(table?.getAttribute("dir")).toBe("ltr");
    expect(firstRowCells.map((cell) => cell.getAttribute("dir"))).toEqual(["auto", "auto"]);
    expect(firstRowCells[0]!.getBoundingClientRect().left).toBeLessThan(
      firstRowCells[1]!.getBoundingClientRect().left,
    );

    await screen.unmount();
  });

  it("keeps technical content LTR and retains direction ownership while streaming", async () => {
    const initialText =
      "راجع [التوثيق](https://example.com/docs) واستخدم `npm run test`\n\n```sh\nnpm run test\n```";
    const screen = await render(
      <ChatMarkdown text={initialText} cwd={undefined} directionMode="auto-blocks" isStreaming />,
    );

    const root = markdownRoot();
    const paragraph = root.querySelector("p");
    const link = root.querySelector<HTMLAnchorElement>("p a");
    const inlineCode = root.querySelector<HTMLElement>("p code");
    const codeBlock = root.querySelector<HTMLElement>(".chat-markdown-codeblock");
    expect(getComputedStyle(paragraph!).direction).toBe("rtl");
    expect(link?.getAttribute("dir")).toBe("auto");
    expect(link?.href).toBe("https://example.com/docs");
    expect(link?.textContent).toContain("التوثيق");
    expect(getComputedStyle(link!).direction).toBe("rtl");
    expect(inlineCode?.getAttribute("dir")).toBe("ltr");
    expect(getComputedStyle(inlineCode!).direction).toBe("ltr");
    expect(codeBlock?.getAttribute("dir")).toBe("ltr");

    await screen.rerender(
      <ChatMarkdown
        text={`${initialText}\n\nEnglish follows.`}
        cwd={undefined}
        directionMode="auto-blocks"
        isStreaming
      />,
    );
    expect(markdownRoot()).toBe(root);
    expect(root.querySelector("p")?.getAttribute("dir")).toBe("auto");
    expect(getComputedStyle(root.querySelector("p")!).direction).toBe("rtl");

    await screen.unmount();
  });
});
