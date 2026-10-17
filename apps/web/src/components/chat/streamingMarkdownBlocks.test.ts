import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";

import {
  buildStreamingMarkdownChildren,
  splitStreamingMarkdownBlocks,
  type StreamingMarkdownBlock,
  type StreamingMarkdownChildren,
} from "./streamingMarkdownBlocks";

// Samples exercising every construct the splitter must not cut through.
const STREAMING_MARKDOWN_CORPUS: Readonly<Record<string, string>> = {
  headings:
    "# Title\n\nIntro paragraph.\n\n## Part one\n\nBody one.\n\n### Part two\n\nBody two.\n",
  fences:
    "Intro.\n\n```ts\nconst a = 1;\n\n# not a heading\n\n---\n```\n\nAfter code.\n\n~~~\nraw\n\n```\nstill raw\n~~~\n\n````md\n```\ninner\n```\n````\n\n## Done\n",
  unclosedFence: "## Start\n\n```js\nlet x = 1;\n\n# inside\n\n---\n",
  nestedLists:
    "- one\n- two\n\n  continued two\n\n  - nested a\n\n  - nested b\n- three\n\n1. Step\n\n   ```bash\n   npm i\n\n   npm test\n   ```\n\n2. Next step\n3. Last\n\n## After lists\n\nText.\n",
  listFenceClosedByHeading:
    "- item\n\n  ```\n  code\n\n# heading\n  ```\n\n## later\n\n```\nopen\n\n# inside\n",
  tables:
    "| a | b |\n|---|---|\n| 1 | 2 |\n\n## Next\n\n| x | y | z |\n|---|---|\n| 3 | 4 | 5 |\n---\n\nAfter.\n",
  blockquotes:
    "> quote line\n>\n> # quoted heading\n\n# Real heading\n\n> [!NOTE]\n> Alert body\n> ```\n> code\n\n```\nfence after quote\n```\n\n---\n\nEnd.\n",
  mathBlocks:
    "Before.\n\n$$\na = b\n\n# not heading\n\n$$\n\nInline $x^2$ math.\n\n## Next\n\n$$x$$\n\n### Last\n",
  htmlBlocks:
    "<details>\n<summary>More</summary>\n\n# inside details\n\n</details>\n\n## After\n\n<!--\n\n# hidden\n\n-->\n\n## Final\n",
  referenceLinks:
    "See [the docs][docs].\n\n## Section\n\nMore [docs].\n\n[docs]: https://example.com\n",
  footnotes: "Claim[^1].\n\n## Section\n\nText.\n\n[^1]: The note.\n",
  thematicBreaks:
    "Para one.\n\n---\n\nPara two.\n\n***\n\nPara three.\n\n___\n\nSetext\n---\n\n## End\n",
  indentedCode: "Text.\n\n    code line\n\n    # indented hash\n\n## Heading\n",
  lazyContinuation: "- item\nlazy line\n\n## Heading\n\nText.\n",
  tabs: "- item\n\tmore\n\n## Heading\n\n```go\nfunc main() {\n\tfmt.Println(1)\n}\n```\n\n## End\n",
  orderedInterrupt: "Paragraph\n3. not a list\n\n## Heading\n\n1. real\n2. list\n\n## End\n",
  tsIndexSignature:
    "## Types\n\n```ts\ninterface Bag {\n  [key: string]: number;\n}\n```\n\n## End\n",
};

type TopLevelRange = { start: number; end: number };

function topLevelRanges(text: string): TopLevelRange[] {
  const ranges: TopLevelRange[] = [];
  const capture =
    () =>
    (tree: {
      children: Array<{ position?: { start: { offset?: number }; end: { offset?: number } } }>;
    }) => {
      for (const child of tree.children) {
        ranges.push({
          start: child.position?.start.offset ?? -1,
          end: child.position?.end.offset ?? -1,
        });
      }
    };
  ReactMarkdown({
    children: text,
    remarkPlugins: [remarkGfm, [remarkMath, { singleDollarTextMath: true }], capture],
  });
  return ranges;
}

function boundaries(blocks: readonly StreamingMarkdownBlock[]): number[] {
  return blocks.slice(1).map((block) => block.offset);
}

function expectValidBoundaries(text: string, blocks: readonly StreamingMarkdownBlock[]): void {
  const ranges = topLevelRanges(text);
  for (const boundary of boundaries(blocks)) {
    // Every boundary starts a top-level node and falls inside none.
    expect(ranges.some((range) => range.start === boundary)).toBe(true);
    expect(ranges.some((range) => range.start < boundary && boundary < range.end)).toBe(false);
  }
}

describe("splitStreamingMarkdownBlocks", () => {
  for (const [name, text] of Object.entries(STREAMING_MARKDOWN_CORPUS)) {
    it(`reproduces "${name}" byte for byte and only splits between top-level blocks`, () => {
      const { blocks } = splitStreamingMarkdownBlocks(text);
      expect(blocks.map((block) => block.text).join("")).toBe(text);
      for (const block of blocks) {
        expect(text.slice(block.offset, block.offset + block.text.length)).toBe(block.text);
        expect(text.slice(0, block.offset).split("\n").length).toBe(block.line);
      }
      expectValidBoundaries(text, blocks);
    });

    it(`keeps settled "${name}" blocks stable while the text streams in`, () => {
      let previous = splitStreamingMarkdownBlocks("");
      for (let length = 1; length <= text.length; length += 1) {
        const prefix = text.slice(0, length);
        const resumed = splitStreamingMarkdownBlocks(prefix, previous);
        const fresh = splitStreamingMarkdownBlocks(prefix);
        expect(resumed.blocks).toEqual(fresh.blocks);
        // Settled blocks of the shorter prefix stay settled, unchanged, unless
        // a definition arrived and the whole text falls back to one parse.
        const settled = previous.blocks.slice(0, -1);
        if (resumed.blocks.length > 1 || !/\]:/.test(prefix)) {
          expect(resumed.blocks.slice(0, settled.length)).toEqual(settled);
        }
        expectValidBoundaries(prefix, resumed.blocks);
        previous = resumed;
      }
    });
  }

  it("splits before headings, fences and breaks after a blank line, and after fences", () => {
    const text = STREAMING_MARKDOWN_CORPUS.fences!;
    expect(splitStreamingMarkdownBlocks(text).blocks.map((block) => block.text)).toEqual([
      "Intro.\n\n",
      "```ts\nconst a = 1;\n\n# not a heading\n\n---\n```\n\n",
      "After code.\n\n",
      "~~~\nraw\n\n```\nstill raw\n~~~\n\n",
      "````md\n```\ninner\n```\n````\n\n",
      "## Done\n",
    ]);
  });

  it("never splits lists, list fences, tables, quotes, math or HTML blocks", () => {
    expect(
      boundaries(splitStreamingMarkdownBlocks(STREAMING_MARKDOWN_CORPUS.nestedLists!).blocks),
    ).toEqual([STREAMING_MARKDOWN_CORPUS.nestedLists!.indexOf("## After lists")]);
    const mathText = STREAMING_MARKDOWN_CORPUS.mathBlocks!;
    expect(boundaries(splitStreamingMarkdownBlocks(mathText).blocks)).toEqual([
      mathText.indexOf("\nInline") + 1,
      mathText.indexOf("## Next"),
      mathText.indexOf("### Last"),
    ]);
    const tableText = STREAMING_MARKDOWN_CORPUS.tables!;
    expect(boundaries(splitStreamingMarkdownBlocks(tableText).blocks)).toEqual([
      tableText.indexOf("## Next"),
    ]);
    // HTML blocks that can span blank lines stop all further splitting.
    expect(splitStreamingMarkdownBlocks(STREAMING_MARKDOWN_CORPUS.htmlBlocks!).blocks).toHaveLength(
      1,
    );
  });

  it("closes a list item's fence at a column-0 heading and tracks the next fence", () => {
    // The indented fence after the heading is top-level; it swallows `## later`.
    const text = STREAMING_MARKDOWN_CORPUS.listFenceClosedByHeading!;
    expect(boundaries(splitStreamingMarkdownBlocks(text).blocks)).toEqual([
      text.indexOf("# heading"),
      text.indexOf("open\n"),
      text.indexOf("# inside"),
    ]);
  });

  it("does not split text with reference or footnote definitions", () => {
    expect(
      splitStreamingMarkdownBlocks(STREAMING_MARKDOWN_CORPUS.referenceLinks!).blocks,
    ).toHaveLength(1);
    expect(splitStreamingMarkdownBlocks(STREAMING_MARKDOWN_CORPUS.footnotes!).blocks).toHaveLength(
      1,
    );
    // Inside fenced code, `[key: string]:` is code, not a definition.
    expect(
      splitStreamingMarkdownBlocks(STREAMING_MARKDOWN_CORPUS.tsIndexSignature!).blocks.length,
    ).toBeGreaterThan(1);
  });

  it("stops splitting after lines it cannot classify with certainty", () => {
    expect(
      splitStreamingMarkdownBlocks(STREAMING_MARKDOWN_CORPUS.lazyContinuation!).blocks,
    ).toHaveLength(1);
    expect(splitStreamingMarkdownBlocks(STREAMING_MARKDOWN_CORPUS.tabs!).blocks).toHaveLength(1);
    expect(
      splitStreamingMarkdownBlocks(STREAMING_MARKDOWN_CORPUS.orderedInterrupt!).blocks,
    ).toHaveLength(1);
  });

  it("renders random line mixes identically block by block and as a whole", () => {
    // Seeded so a failure reproduces; each line is a construct the scanner
    // has to classify (or give up on) correctly.
    const lines = [
      "",
      "",
      "",
      "# H",
      "## H2",
      "text",
      "more text",
      "- a",
      "- b",
      "  - c",
      "  text",
      "    code",
      "1. one",
      "2. two",
      "3) three",
      "   x",
      "```",
      "```js",
      "  ```",
      "   ```",
      "~~~",
      "````",
      "$$",
      "  $$",
      "$$ x",
      "> q",
      ">",
      "> ```",
      "> # h",
      "---",
      "***",
      "___",
      "* * *",
      "| a | b |",
      "|---|---|",
      "<div>",
      "</div>",
      "<!--",
      "-->",
      "<br>",
      "===",
      "-",
      "1.",
      "+ p",
      "      deep",
      "\tTab",
      "- ```",
      "- # h",
      "- > q",
      "  > q",
      "[x](y)",
      "*",
      "10. ten",
      "$x$ y",
      "a $$b$$",
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const remarkPlugins: MarkdownOptions["remarkPlugins"] = [
      remarkGfm,
      [remarkMath, { singleDollarTextMath: true }],
    ];
    const html = (text: string) =>
      renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins }, text));
    let splitTexts = 0;
    for (let doc = 0; doc < 150; doc += 1) {
      const count = 3 + Math.floor(random() * 25);
      const full = Array.from(
        { length: count },
        () => lines[Math.floor(random() * lines.length)]!,
      ).join("\n");
      for (let cut = 1; cut <= full.length; cut += 1 + Math.floor(random() * 8)) {
        const text = full.slice(0, cut);
        const { blocks } = splitStreamingMarkdownBlocks(text);
        if (blocks.length < 2) continue;
        splitTexts += 1;
        const joined = blocks
          .map((block) => html(block.text))
          .filter((markup) => markup.length > 0)
          .join("\n");
        expect(joined, JSON.stringify(text)).toBe(html(text));
      }
    }
    expect(splitTexts).toBeGreaterThan(100);
  });

  it("does not split carriage-return text", () => {
    expect(splitStreamingMarkdownBlocks("# a\r\n\r\n# b\r\n").blocks).toHaveLength(1);
  });
});

// Text children as-is, elements by key: what React reconciles by.
function childShape(children: readonly ReactNode[]): Array<string | null> {
  return children.map((child) =>
    typeof child === "string" ? child : (child as { key: string | null }).key,
  );
}

describe("buildStreamingMarkdownChildren", () => {
  const settledText = Array.from(
    { length: 10 },
    (_, index) => `## Section ${index}\n\nParagraph ${index} body.\n\n`,
  ).join("");

  function countingParser() {
    const parsed: string[] = [];
    const parseBlock = (block: StreamingMarkdownBlock): readonly ReactNode[] => {
      parsed.push(block.text);
      const children = (ReactMarkdown({ children: block.text }).props as { children?: ReactNode })
        .children;
      return Array.isArray(children) ? children : [children];
    };
    return { parsed, parseBlock };
  }

  it("parses settled blocks once while 50 chunks stream into the tail", () => {
    const { parsed, parseBlock } = countingParser();
    const options = {};
    let text = `${settledText}## Tail\n\n`;
    let result: StreamingMarkdownChildren<object> = buildStreamingMarkdownChildren(
      null,
      text,
      true,
      options,
      parseBlock,
    );
    const settledBlocks = result.split!.blocks.slice(0, -1);
    expect(settledBlocks.length).toBeGreaterThanOrEqual(10);
    const settledChildren = result.blocks
      .slice(0, settledBlocks.length)
      .map((block) => block.keyed);
    parsed.length = 0;

    for (let chunk = 0; chunk < 50; chunk += 1) {
      text += `word${chunk} `;
      result = buildStreamingMarkdownChildren(result, text, true, { ...options }, parseBlock);
    }

    expect(parsed).toHaveLength(50);
    for (const block of settledBlocks) expect(parsed).not.toContain(block.text);
    expect(result.blocks.slice(0, settledBlocks.length).map((block) => block.keyed)).toEqual(
      settledChildren,
    );
    for (const [index, keyed] of settledChildren.entries()) {
      expect(result.blocks[index]!.keyed).toBe(keyed);
    }
  });

  it("matches a single parse's keys and newline separators", () => {
    const { parseBlock } = countingParser();
    const text = `${settledText}Tail.`;
    const split = buildStreamingMarkdownChildren(null, text, true, {}, parseBlock).children;
    const whole = buildStreamingMarkdownChildren(null, text, false, {}, parseBlock).children;
    expect(childShape(split)).toEqual(childShape(whole));
  });
});
