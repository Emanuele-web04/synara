import { describe, expect, it } from "vitest";

import {
  INLINE_VISUAL_CONTENT_SECURITY_POLICY,
  buildInlineVisualDocument,
  clampInlineVisualHeight,
  readInlineVisualEmbedIds,
  readInlineVisualFrameMessage,
} from "./inlineVisual";

const theme = { appearance: "dark", variables: { "--foreground": "#eee" } } as const;

describe("buildInlineVisualDocument", () => {
  it.each([
    ["a leading script", "<script>fetch('https://example.com')</script><p>chart</p>"],
    [
      "its own doctype",
      "<!DOCTYPE html><html><head><script>1</script></head><body>x</body></html>",
    ],
    ["a leading comment", "<!-- <head> --><script>1</script>"],
    ["a bare fragment", "<svg width='10' height='10'></svg>"],
  ])("puts the policy before every agent byte when the page has %s", (_case, html) => {
    const document = buildInlineVisualDocument(html, theme);
    const policyAt = document.indexOf(
      `<meta http-equiv="Content-Security-Policy" content="${INLINE_VISUAL_CONTENT_SECURITY_POLICY}">`,
    );
    const agentAt = document.lastIndexOf(html.replace(/^<!DOCTYPE html>/i, ""));

    expect(document.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    expect(policyAt).toBeGreaterThan(-1);
    expect(agentAt).toBeGreaterThan(policyAt);
    // A second doctype after the policy would be a parse error at best.
    expect(document.match(/<!doctype/gi)).toHaveLength(1);
  });

  it("allows no network fetches, frames, workers, forms, or base override", () => {
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(INLINE_VISUAL_CONTENT_SECURITY_POLICY).toContain(directive);
    }
    expect(INLINE_VISUAL_CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*|'self'/);
  });

  it("keeps theme values from closing the style element or injecting rules", () => {
    const document = buildInlineVisualDocument("<p>x</p>", {
      appearance: "light",
      variables: {
        "--foreground": "red;}</style><script>alert(1)</script>",
        "--Bad Name": "blue",
      },
    });
    const style = /<style id="synara-visual-theme">([^]*?)<\/style>/.exec(document)?.[1] ?? "";

    expect(style).toContain("color-scheme:light;");
    expect(style).toContain("--foreground:red/stylescriptalert(1)/script;");
    expect(style).not.toContain("--Bad Name");
    expect(document.match(/<\/style>/g)).toHaveLength(1);
  });
});

const rpc = (method: string, params: unknown, id?: string | number) => ({
  jsonrpc: "2.0",
  method,
  params,
  ...(id === undefined ? {} : { id }),
});

describe("readInlineVisualFrameMessage", () => {
  it.each([
    [rpc("ui/notifications/size-changed", { height: 412.5 }), { type: "size", height: 412.5 }],
    [rpc("ui/notifications/size-changed", { height: 0 }), undefined],
    [rpc("ui/notifications/size-changed", { height: Number.POSITIVE_INFINITY }), undefined],
    [rpc("ui/notifications/size-changed", { height: "500" }), undefined],
    [
      rpc("ui/open-link", { url: "https://example.com/a?b=1" }, "link-1"),
      { type: "open-link", id: "link-1", url: "https://example.com/a?b=1" },
    ],
    [rpc("ui/open-link", { url: "javascript:alert(1)" }, 1), undefined],
    [rpc("ui/open-link", { url: "file:///etc/passwd" }, 1), undefined],
    [rpc("ui/open-link", { url: "/relative" }, 1), undefined],
    [rpc("ui/open-link", { url: `https://example.com/${"a".repeat(2100)}` }, 1), undefined],
    [rpc("ui/open-link", { url: "https://example.com" }), undefined],
    [
      rpc("synara/notifications/scroll-intent", { upward: true }),
      { type: "scroll-intent", upward: true },
    ],
    [rpc("synara/notifications/scroll-intent", { upward: "yes" }), undefined],
    [rpc("tools/call", { name: "x" }, 1), undefined],
    [{ method: "ui/notifications/size-changed", params: { height: 10 } }, undefined],
    ["ui/notifications/size-changed", undefined],
    [null, undefined],
  ])("reads %j as %j", (data, expected) => {
    expect(readInlineVisualFrameMessage(data)).toEqual(expected);
  });
});

describe("clampInlineVisualHeight", () => {
  it.each([
    [20, 80],
    [412.4, 412],
    [50_000, 1600],
    [Number.NaN, 80],
  ])("clamps %d to %d", (height, expected) => {
    expect(clampInlineVisualHeight(height)).toBe(expected);
  });
});

describe("readInlineVisualEmbedIds", () => {
  const id = (char: string) => `vis_${char.repeat(32)}`;

  it("finds the visuals a reply places, in order", () => {
    const text = [
      "Intro.",
      "```synara-visual",
      id("a"),
      "```",
      "Middle.",
      "~~~ synara-visual",
      `  ${id("b")}`,
      "~~~",
    ].join("\n");
    expect(readInlineVisualEmbedIds(text)).toEqual([id("a"), id("b")]);
  });

  it("ignores other fences, inline mentions, and malformed ids", () => {
    expect(readInlineVisualEmbedIds("```ts\n" + id("a") + "\n```")).toEqual([]);
    expect(readInlineVisualEmbedIds("see synara-visual " + id("a"))).toEqual([]);
    expect(readInlineVisualEmbedIds("```synara-visual\nvis_123\n```")).toEqual([]);
  });
});

it("does not claim incomplete or extra-content fences as placed visuals", () => {
  const id = `vis_${"a".repeat(32)}`;
  expect(readInlineVisualEmbedIds(`\`\`\`synara-visual\n${id}\nextra narration\n\`\`\``)).toEqual(
    [],
  );
  expect(readInlineVisualEmbedIds(`\`\`\`synara-visual\n${id}`)).toEqual([]);
  expect(readInlineVisualEmbedIds(`\`\`\`synara-visual\n${id}\n\`\`\``)).toEqual([id]);
});
