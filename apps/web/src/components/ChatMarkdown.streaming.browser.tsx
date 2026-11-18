// Preserve state and current callbacks while streaming markdown updates.
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

// Records every markdown parse while keeping the real renderer.
const parsedTexts = vi.hoisted((): string[] => []);
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    default: (options: Parameters<typeof actual.default>[0]) => {
      parsedTexts.push(options.children ?? "");
      return actual.default(options);
    },
    defaultUrlTransform: actual.defaultUrlTransform,
  };
});

import ChatMarkdown from "./ChatMarkdown";
import { splitStreamingMarkdownBlocks } from "./chat/streamingMarkdownBlocks";

const fenced = "```javascript\nconst answer = 42;\n```\n\nExplanation.";

describe("ChatMarkdown streaming identity", () => {
  it.each([false, true])(
    "keeps the code block and chosen soft wrap while prose streams after it (wrap=%s)",
    async (wrap) => {
      const screen = await render(<ChatMarkdown text={fenced} cwd={undefined} isStreaming />);
      const block = document.querySelector(".chat-markdown-codeblock");
      expect(block?.getAttribute("data-wrap")).toBe("true");
      await screen.getByRole("button", { name: "Disable soft wrap", exact: true }).click();
      expect(block?.getAttribute("data-wrap")).toBe("false");
      if (wrap) {
        await screen.getByRole("button", { name: "Enable soft wrap", exact: true }).click();
      }
      expect(block?.getAttribute("data-wrap")).toBe(String(wrap));

      await screen.rerender(
        <ChatMarkdown text={fenced + " More detail."} cwd={undefined} isStreaming />,
      );
      expect(document.querySelector(".chat-markdown-codeblock")).toBe(block);
      expect(block?.getAttribute("data-wrap")).toBe(String(wrap));
      await screen.unmount();
    },
  );

  it("shows the complete growing code when the stream finishes", async () => {
    const screen = await render(
      <ChatMarkdown text={"```text\npartial"} cwd={undefined} isStreaming />,
    );
    const finalCode = "partial\ncomplete final line";
    await screen.rerender(
      <ChatMarkdown
        text={`\`\`\`text\n${finalCode}\n\`\`\``}
        cwd={undefined}
        isStreaming={false}
      />,
    );
    await expect
      .poll(() => document.querySelector(".chat-markdown-codeblock pre")?.textContent)
      .toContain(finalCode);
    await screen.unmount();
  });

  it("uses the latest checkbox callback without changing markdown text", async () => {
    const previous = vi.fn();
    const current = vi.fn();
    const screen = await render(
      <ChatMarkdown text="- [ ] Task" cwd={undefined} onTaskToggle={previous} />,
    );
    await screen.rerender(
      <ChatMarkdown text="- [ ] Task" cwd={undefined} onTaskToggle={current} />,
    );
    await screen.getByRole("checkbox").click();
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith({ sourceLine: 1, checked: true });
    await screen.unmount();
  });

  it("parses settled blocks once and keeps their DOM through the end of the stream", async () => {
    let text = Array.from(
      { length: 10 },
      (_, index) => `## Section ${index}\n\nParagraph ${index}.\n\n`,
    ).join("");
    text += "## Tail\n\nStart";
    const settledBlocks = splitStreamingMarkdownBlocks(text).blocks.slice(0, -1);
    expect(settledBlocks.length).toBeGreaterThanOrEqual(10);
    const screen = await render(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
    const headings = Array.from(document.querySelectorAll("h2"));
    expect(headings).toHaveLength(11);

    parsedTexts.length = 0;
    for (let chunk = 0; chunk < 50; chunk += 1) {
      text += ` word${chunk}`;
      await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
    }
    await expect.poll(() => document.body.textContent).toContain("word49");
    expect(parsedTexts.length).toBeGreaterThan(0);
    for (const block of settledBlocks) expect(parsedTexts).not.toContain(block.text);
    expect(Array.from(document.querySelectorAll("h2"))).toEqual(headings);
    headings.forEach((heading, index) => {
      expect(document.querySelectorAll("h2")[index]).toBe(heading);
    });

    // The stream ends with one parse of the whole text, rendered into the
    // same DOM nodes.
    parsedTexts.length = 0;
    const paragraphs = Array.from(document.querySelectorAll("p"));
    await screen.rerender(<ChatMarkdown text={text} cwd={undefined} isStreaming={false} />);
    expect(parsedTexts).toEqual([text]);
    headings.forEach((heading, index) => {
      expect(document.querySelectorAll("h2")[index]).toBe(heading);
    });
    paragraphs.forEach((paragraph, index) => {
      expect(document.querySelectorAll("p")[index]).toBe(paragraph);
    });
    await screen.unmount();
  });

  it("reports absolute task lines from a later block while streaming", async () => {
    const onTaskToggle = vi.fn();
    const text = "## One\n\nIntro.\n\n## Two\n\n- [ ] task\n\n## Three\n\nMore";
    expect(splitStreamingMarkdownBlocks(text).blocks.length).toBeGreaterThan(2);
    const screen = await render(
      <ChatMarkdown text={text} cwd={undefined} isStreaming onTaskToggle={onTaskToggle} />,
    );
    await screen.getByRole("checkbox").click();
    expect(onTaskToggle).toHaveBeenCalledWith({ sourceLine: 7, checked: true });
    await screen.unmount();
  });
});
