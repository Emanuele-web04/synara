import { describe, expect, it } from "vitest";

import {
  splitPromptIntoComposerSegments,
  splitPromptIntoDisplaySegments,
} from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("splitPromptIntoComposerSegments", () => {
  it("splits mention tokens followed by whitespace into mention segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("marks selected provider mention references as plugin mentions", () => {
    expect(
      splitPromptIntoComposerSegments(
        "Use @Gmail please",
        [],
        [{ name: "gmail", path: "plugin://gmail@openai-curated" }],
      ),
    ).toEqual([
      { type: "text", text: "Use " },
      { type: "mention", path: "Gmail", kind: "plugin" },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing mention token", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md")).toEqual([
      { type: "text", text: "Inspect @AGENTS.md" },
    ]);
  });

  it("does not convert an incomplete trailing dollar skill token", () => {
    expect(splitPromptIntoComposerSegments("Use $check-code")).toEqual([
      { type: "text", text: "Use $check-code" },
    ]);
  });

  it("does not convert an incomplete trailing slash skill token", () => {
    expect(splitPromptIntoComposerSegments("Use /check-code")).toEqual([
      { type: "text", text: "Use /check-code" },
    ]);
  });

  it("converts completed dollar skill tokens once a trailing delimiter exists", () => {
    expect(splitPromptIntoComposerSegments("Use $check-code please")).toEqual([
      { type: "text", text: "Use " },
      { type: "skill", name: "check-code", prefix: "$" },
      { type: "text", text: " please" },
    ]);
  });

  it("converts completed slash skill tokens once a trailing delimiter exists", () => {
    expect(splitPromptIntoComposerSegments("Use /check-code please")).toEqual([
      { type: "text", text: "Use " },
      { type: "skill", name: "check-code", prefix: "/" },
      { type: "text", text: " please" },
    ]);
  });

  it("keeps built-in slash commands as plain text", () => {
    expect(splitPromptIntoComposerSegments("/plan ")).toEqual([{ type: "text", text: "/plan " }]);
    expect(splitPromptIntoComposerSegments("/model spark")).toEqual([
      { type: "text", text: "/model spark" },
    ]);
  });

  it("keeps a typed agent alias as plain text until parentheses are added", () => {
    expect(splitPromptIntoComposerSegments("Ask @spark")).toEqual([
      { type: "text", text: "Ask @spark" },
    ]);
  });

  it("converts an agent alias into a chip once the task parentheses begin", () => {
    expect(splitPromptIntoComposerSegments("Ask @spark()")).toEqual([
      { type: "text", text: "Ask " },
      { type: "agent-mention", alias: "spark", color: "cyan" },
      { type: "text", text: "()" },
    ]);
  });

  it("keeps newlines around mention tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      { type: "mention", path: "src/index.ts" },
      { type: "text", text: " \ntwo" },
    ]);
  });

  it("supports quoted mention tokens so folder paths can include spaces", () => {
    expect(
      splitPromptIntoComposerSegments('Inspect @"/Users/test/Application Support" please'),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "/Users/test/Application Support" },
      { type: "text", text: " please" },
    ]);
  });

  it("keeps inline terminal context placeholders at their prompt positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md please`,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("converts browser editor blocks into context card segments", () => {
    const block = [
      "<browser-element-selection>",
      "url: http://localhost:8891/browser-editor-demo/index.html",
      "title: Northstar Studio - Browser Editor Demo",
      "selector: div.page > main > section.hero > h1",
      "tag: h1",
      "role: (none)",
      "accessibleName: Launch experiments without losing the plot.",
      "viewport: width=447, height=806, devicePixelRatio=2",
      "bounds: x=22, y=108, width=387, height=184",
      "attributes:",
      "none",
      "text: Launch experiments without losing the plot.",
      "outerHTML:",
      "<h1>Launch experiments without losing the plot.</h1>",
      "</browser-element-selection>",
    ].join("\n");

    expect(splitPromptIntoComposerSegments(`Please edit this\n\n${block}`)).toEqual([
      { type: "text", text: "Please edit this\n\n" },
      {
        type: "browser-context",
        context: expect.objectContaining({
          block,
          detail: "Launch experiments without losing the plot.",
          kind: "element",
          label: "Browser element: h1",
          title: "Northstar Studio - Browser Editor Demo",
          url: "http://localhost:8891/browser-editor-demo/index.html",
        }),
      },
    ]);
  });
});

describe("splitPromptIntoDisplaySegments", () => {
  it("converts a trailing skill token for read-only rendering", () => {
    expect(splitPromptIntoDisplaySegments("$check-code")).toEqual([
      { type: "skill", name: "check-code", prefix: "$" },
    ]);
  });

  it("converts a trailing skill token at the end of surrounding text", () => {
    expect(splitPromptIntoDisplaySegments("Use $check-code")).toEqual([
      { type: "text", text: "Use " },
      { type: "skill", name: "check-code", prefix: "$" },
    ]);
  });

  it("renders trailing quoted mention tokens at the end of text", () => {
    expect(splitPromptIntoDisplaySegments('Use @"/Users/test/Application Support"')).toEqual([
      { type: "text", text: "Use " },
      { type: "mention", path: "/Users/test/Application Support" },
    ]);
  });
});
