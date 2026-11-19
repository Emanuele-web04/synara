import { describe, expect, it } from "vitest";

import {
  acpArgsFromText,
  acpArgsToText,
  acpModelSlugsFromText,
  acpModelSlugsToText,
} from "./acpAgentConfigText";

describe("acpArgsFromText", () => {
  it("splits on whitespace and keeps quoted words together", () => {
    expect(acpArgsFromText("  acp --port  4096 ")).toEqual(["acp", "--port", "4096"]);
    expect(acpArgsFromText('--model "claude sonnet 4.5" --flag')).toEqual([
      "--model",
      "claude sonnet 4.5",
      "--flag",
    ]);
    expect(acpArgsFromText("a 'b c' d")).toEqual(["a", "b c", "d"]);
    expect(acpArgsFromText("")).toEqual([]);
    expect(acpArgsFromText('""')).toEqual([""]);
  });
});

describe("acpArgsToText", () => {
  it("quotes args containing whitespace or quotes and skips non-strings", () => {
    expect(acpArgsToText(["acp", "--port", "4096"])).toBe("acp --port 4096");
    expect(acpArgsToText(["--model", "claude sonnet 4.5"])).toBe('--model "claude sonnet 4.5"');
    expect(acpArgsToText(["a", 1, null, "b"])).toBe("a b");
  });
});

describe("acpModelSlugsFromText / acpModelSlugsToText", () => {
  it("parses comma or whitespace separated slugs, deduped", () => {
    expect(acpModelSlugsFromText("a/b, c/d  e/f, a/b")).toEqual([
      { slug: "a/b" },
      { slug: "c/d" },
      { slug: "e/f" },
    ]);
  });

  it("round-trips model entries with names intact in their objects", () => {
    expect(acpModelSlugsToText([{ slug: "a/b", name: "B" }, { slug: "c/d" }, "junk", {}])).toBe(
      "a/b, c/d",
    );
  });
});
