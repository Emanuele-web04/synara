import { describe, expect, it } from "vitest";
import { dedentCode, parseCodeFenceInfo } from "./codeFence";

describe("parseCodeFenceInfo", () => {
  it("parses a bare language token", () => {
    const result = parseCodeFenceInfo("typescript");
    expect(result.language).toBe("typescript");
    expect(result.isFileReference).toBe(false);
    expect(result.filePath).toBeNull();
    expect(result.fileName).toBeNull();
    expect(result.directory).toBeNull();
    expect(result.lineRange).toBeNull();
  });

  it('maps gitignore to ini for Shiki compatibility', () => {
    const result = parseCodeFenceInfo("gitignore");
    expect(result.language).toBe("ini");
    expect(result.isFileReference).toBe(false);
  });

  it('falls back to "text" for empty info strings', () => {
    const result = parseCodeFenceInfo("");
    expect(result.language).toBe("text");
  });

  it('falls back to "text" for whitespace-only info strings', () => {
    const result = parseCodeFenceInfo("   ");
    expect(result.language).toBe("text");
  });

  it("parses a Cursor-style file reference with differing start/end lines", () => {
    const result = parseCodeFenceInfo("1:10:src/foo.ts");
    expect(result.isFileReference).toBe(true);
    expect(result.filePath).toBe("src/foo.ts");
    expect(result.fileName).toBe("foo.ts");
    expect(result.directory).toBe("src");
    expect(result.lineRange).toBe("1-10");
  });

  it("parses a Cursor-style file reference with same start/end line", () => {
    const result = parseCodeFenceInfo("5:5:src/bar.ts");
    expect(result.isFileReference).toBe(true);
    expect(result.filePath).toBe("src/bar.ts");
    expect(result.lineRange).toBe("5");
  });

  it("treats a bare path as an un-ranged file reference", () => {
    const result = parseCodeFenceInfo("src/components/Button.tsx");
    expect(result.isFileReference).toBe(true);
    expect(result.filePath).toBe("src/components/Button.tsx");
    expect(result.fileName).toBe("Button.tsx");
    expect(result.directory).toBe("src/components");
    expect(result.lineRange).toBeNull();
  });

  it("treats a Windows-style bare path as a file reference", () => {
    const result = parseCodeFenceInfo("src\\components\\Button.tsx");
    expect(result.isFileReference).toBe(true);
    expect(result.filePath).toBe("src\\components\\Button.tsx");
    expect(result.fileName).toBe("Button.tsx");
    expect(result.lineRange).toBeNull();
  });

  it("handles a root-level file path", () => {
    const result = parseCodeFenceInfo("package.json");
    expect(result.isFileReference).toBe(false);
    expect(result.language).toBe("json");
  });

  it("handles leading/trailing whitespace in the info string", () => {
    const result = parseCodeFenceInfo("  python  ");
    expect(result.language).toBe("python");
    expect(result.isFileReference).toBe(false);
  });
});

describe("dedentCode", () => {
  it("returns the input unchanged when already flush-left", () => {
    const code = "line1\nline2\nline3";
    expect(dedentCode(code)).toBe(code);
  });

  it("removes common leading indentation", () => {
    const code = "  line1\n  line2\n  line3";
    expect(dedentCode(code)).toBe("line1\nline2\nline3");
  });

  it("removes only the common minimum indentation", () => {
    const code = "    line1\n  line2\n    line3";
    expect(dedentCode(code)).toBe("  line1\nline2\n  line3");
  });

  it("skips empty lines when calculating min indent", () => {
    const code = "  line1\n\n  line2";
    expect(dedentCode(code)).toBe("line1\n\nline2");
  });

  it("returns empty string for empty input", () => {
    expect(dedentCode("")).toBe("");
  });

  it("returns single-line input unchanged when flush-left", () => {
    expect(dedentCode("single")).toBe("single");
  });

  it("dedents a single indented line", () => {
    expect(dedentCode("    indented")).toBe("indented");
  });

  it("handles tab indentation", () => {
    const code = "\t\tline1\n\t\tline2";
    expect(dedentCode(code)).toBe("line1\nline2");
  });
});
