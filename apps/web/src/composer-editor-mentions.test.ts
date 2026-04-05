import { describe, expect, it } from "vitest";

import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("splitPromptIntoComposerSegments", () => {
  it("splits mention tokens followed by whitespace into mention segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md" },
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

  it("converts completed skill tokens once a trailing delimiter exists", () => {
    expect(splitPromptIntoComposerSegments("Use $check-code please")).toEqual([
      { type: "text", text: "Use " },
      { type: "skill", name: "check-code", prefix: "$" },
      { type: "text", text: " please" },
    ]);
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

  it("keeps newlines around mention tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      { type: "mention", path: "src/index.ts" },
      { type: "text", text: " \ntwo" },
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
});
