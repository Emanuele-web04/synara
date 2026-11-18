import ReactMarkdown from "react-markdown";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dedentCode } from "./codeFence";
import { resolveDiffThemeName } from "./diffRendering";
import {
  codeHighlightJobsForMarkdown,
  createCodeHighlightPrewarmer,
  extractFencedCodeBlocks,
  PREWARM_MAX_BLOCK_CHARS,
  type CodeHighlightingApi,
  type CodeHighlightPrewarmHost,
} from "./codeHighlightPrewarm";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

/** What ChatMarkdown's `pre` component receives for each fenced block, via the real parser. */
function parsedCodeBlocks(markdown: string) {
  const blocks: Array<{ rawInfo: string; code: string }> = [];
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        components: {
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const props = (child as { props: { className?: string; children?: ReactNode } }).props;
            blocks.push({
              rawInfo: props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "text",
              code: dedentCode(textOf(props.children)),
            });
            return null;
          },
        },
      },
      markdown,
    ),
  );
  return blocks;
}

const DARK = resolveDiffThemeName("dark");

const SAMPLES = [
  "Intro\n\n```ts\nconst a = 1;\n```\n\nAfter",
  "```\nplain\n```",
  "~~~python extra words\nprint(1)\n\n  indented\n~~~",
  "- item\n\n  ```bash\n  bun run test\n    nested\n  ```\n- next",
  "````md\n```inner```\n````",
  "```js\nunclosed();\nstill code",
  "> quote\n\nText ```not a fence``` here\n\n```diff\n+ a\n- b\n```",
  "```ts\n```",
];

describe("extractFencedCodeBlocks", () => {
  it.each(SAMPLES)("matches the markdown parser for %j", (markdown) => {
    expect(extractFencedCodeBlocks(markdown)).toEqual(parsedCodeBlocks(markdown));
  });

  it("skips messages without fences without scanning lines", () => {
    expect(extractFencedCodeBlocks("no code `here`")).toEqual([]);
  });
});

describe("codeHighlightJobsForMarkdown", () => {
  it("resolves the language like ChatMarkdown and skips inline visuals and empty blocks", () => {
    const jobs = codeHighlightJobsForMarkdown(
      "```gitignore\nnode_modules\n```\n\n```synara-visual\nvis-1\n```\n\n```ts\n```\n\n```12:14:src/a.tsx\nx\n```",
    );
    expect(jobs).toEqual([
      { code: "node_modules\n", language: "ini" },
      { code: "x\n", language: "tsx" },
    ]);
  });
});

describe("createCodeHighlightPrewarmer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeHost(options: { busy?: () => boolean; idleMs?: number } = {}) {
    const cache = new Map<string, string>();
    const idleQueue: Array<(deadline: { timeRemaining(): number }) => void> = [];
    const highlighted: string[] = [];
    const api: CodeHighlightingApi = {
      createSyntaxHighlightCacheKey: (code, language, theme) => `${language}:${theme}:${code}`,
      getCachedSyntaxHighlightedHtml: (key) => cache.get(key) ?? null,
      cacheSyntaxHighlightedHtml: (key, html) => void cache.set(key, html),
      getSyntaxHighlighterPromise: (language) =>
        language === "broken" ? Promise.reject(new Error("no grammar")) : Promise.resolve({}),
      highlightCodeToHtmlWithFallback: (_highlighter, code, language) => {
        highlighted.push(`${language}:${code}`);
        return `<pre>${code}</pre>`;
      },
    };
    const host: CodeHighlightPrewarmHost = {
      requestIdle: (callback) => {
        idleQueue.push(callback);
        return () => {
          const index = idleQueue.indexOf(callback);
          if (index !== -1) idleQueue.splice(index, 1);
        };
      },
      isBusy: options.busy ?? (() => false),
      loadHighlighting: () => Promise.resolve(api),
    };
    const flushIdle = async (rounds = 20) => {
      for (let round = 0; round < rounds; round += 1) {
        const callback = idleQueue.shift();
        if (callback) callback({ timeRemaining: () => options.idleMs ?? 50 });
        await Promise.resolve();
        await Promise.resolve();
      }
    };
    return { host, cache, highlighted, idleQueue, flushIdle };
  }

  it("fills the cache in order and skips cached or oversized blocks", async () => {
    const { host, cache, highlighted, flushIdle } = makeHost();
    cache.set(`ts:${DARK}:cached\n`, "<pre>cached</pre>");
    const prewarmer = createCodeHighlightPrewarmer(host);
    prewarmer.start(
      [
        { code: "a\n", language: "ts" },
        { code: "cached\n", language: "ts" },
        { code: "x".repeat(PREWARM_MAX_BLOCK_CHARS + 1), language: "ts" },
        { code: "b\n", language: "bash" },
      ],
      DARK,
    );
    await flushIdle();
    expect(highlighted).toEqual(["ts:a\n", "bash:b\n"]);
    expect(cache.get(`bash:${DARK}:b\n`)).toBe("<pre>b\n</pre>");
  });

  it("starts no block while busy or when the idle period is short", async () => {
    let busy = true;
    const { host, highlighted, flushIdle } = makeHost({ busy: () => busy });
    const prewarmer = createCodeHighlightPrewarmer(host);
    prewarmer.start([{ code: "a\n", language: "ts" }], DARK);
    await flushIdle();
    expect(highlighted).toEqual([]);
    busy = false;
    await flushIdle();
    expect(highlighted).toEqual(["ts:a\n"]);

    const short = makeHost({ idleMs: 2 });
    createCodeHighlightPrewarmer(short.host).start([{ code: "a\n", language: "ts" }], DARK);
    await short.flushIdle();
    expect(short.highlighted).toEqual([]);
  });

  it("stops after cancel and drops languages whose highlighter fails", async () => {
    const { host, highlighted, idleQueue, flushIdle } = makeHost();
    const prewarmer = createCodeHighlightPrewarmer(host);
    prewarmer.start(
      [
        { code: "x\n", language: "broken" },
        { code: "y\n", language: "ts" },
      ],
      DARK,
    );
    await flushIdle();
    expect(highlighted).toEqual(["ts:y\n"]);

    prewarmer.start([{ code: "z\n", language: "ts" }], DARK);
    prewarmer.cancel();
    expect(idleQueue).toHaveLength(0);
    await flushIdle();
    expect(highlighted).toEqual(["ts:y\n"]);
  });
});
