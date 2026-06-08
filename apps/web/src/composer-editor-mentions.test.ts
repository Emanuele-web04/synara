import { describe, expect, it } from "vitest";

import {
  matchComposerLinkToken,
  splitPromptIntoComposerSegments,
  splitPromptIntoDisplaySegments,
} from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("matchComposerLinkToken", () => {
  it("matches a URL only once a delimiter follows it while typing", () => {
    expect(
      matchComposerLinkToken("https://github.com/openai/codex", {
        includeTrailingTokenAtEnd: false,
      }),
    ).toBeNull();
    expect(
      matchComposerLinkToken("https://github.com/openai/codex ", {
        includeTrailingTokenAtEnd: false,
      }),
    ).toEqual({ url: "https://github.com/openai/codex", start: 0, end: 31 });
  });

  it("matches a trailing URL at end-of-text in display mode", () => {
    expect(
      matchComposerLinkToken("see https://github.com/openai/codex", {
        includeTrailingTokenAtEnd: true,
      }),
    ).toEqual({ url: "https://github.com/openai/codex", start: 4, end: 35 });
  });

  it("excludes trailing sentence punctuation from the matched URL", () => {
    expect(
      matchComposerLinkToken("https://example.com. ", {
        includeTrailingTokenAtEnd: false,
      }),
    ).toEqual({ url: "https://example.com", start: 0, end: 19 });
  });
});

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

  it("converts a URL into a link segment once a delimiter follows it", () => {
    expect(
      splitPromptIntoComposerSegments("see https://github.com/openai/codex/pull/1 thanks"),
    ).toEqual([
      { type: "text", text: "see " },
      { type: "link", url: "https://github.com/openai/codex/pull/1" },
      { type: "text", text: " thanks" },
    ]);
  });

  it("does not convert an incomplete trailing URL while typing", () => {
    expect(splitPromptIntoComposerSegments("see https://github.com/openai/codex")).toEqual([
      { type: "text", text: "see https://github.com/openai/codex" },
    ]);
  });

  it("does not treat an @host inside a URL as a mention", () => {
    expect(splitPromptIntoComposerSegments("ping https://user@example.com/path here")).toEqual([
      { type: "text", text: "ping " },
      { type: "link", url: "https://user@example.com/path" },
      { type: "text", text: " here" },
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

  it("converts a trailing URL into a link segment for read-only rendering", () => {
    expect(
      splitPromptIntoDisplaySegments("https://github.com/Emanuele-web04/synara/pull/155"),
    ).toEqual([{ type: "link", url: "https://github.com/Emanuele-web04/synara/pull/155" }]);
  });

  it("renders a URL on its own line followed by trailing prose", () => {
    expect(
      splitPromptIntoDisplaySegments(
        "https://github.com/Emanuele-web04/synara/pull/155\nfix the conflicts",
      ),
    ).toEqual([
      { type: "link", url: "https://github.com/Emanuele-web04/synara/pull/155" },
      { type: "text", text: "\nfix the conflicts" },
    ]);
  });

  it("trims trailing punctuation from a sentence-final URL", () => {
    expect(splitPromptIntoDisplaySegments("open https://example.com.")).toEqual([
      { type: "text", text: "open " },
      { type: "link", url: "https://example.com" },
      { type: "text", text: "." },
    ]);
  });

  it("uses explicit mention references instead of inferring plugins from plain @text", () => {
    expect(splitPromptIntoDisplaySegments("Use @linear")).toEqual([
      { type: "text", text: "Use " },
      { type: "mention", path: "linear" },
    ]);
    expect(
      splitPromptIntoDisplaySegments("Use @linear", [
        { name: "linear", path: "plugin://linear@openai-curated" },
      ]),
    ).toEqual([
      { type: "text", text: "Use " },
      { type: "mention", path: "linear", kind: "plugin" },
    ]);
    expect(
      splitPromptIntoDisplaySegments("Use @linear", [
        { name: "Linear Plugin", path: "plugin://linear@openai-curated" },
      ]),
    ).toEqual([
      { type: "text", text: "Use " },
      { type: "mention", path: "linear", kind: "plugin" },
    ]);
  });
});
