import { describe, expect, it } from "vitest";
import { dedentCode, parseCodeFenceInfo } from "./codeFence";

describe("parseCodeFenceInfo", () => {
  it("parses a Cursor-style file reference with a line range", () => {
    const fence = parseCodeFenceInfo("173:186:packages/shared/src/model.ts");
    expect(fence).toMatchObject({
      isFileReference: true,
      filePath: "packages/shared/src/model.ts",
      fileName: "model.ts",
      directory: "packages/shared/src",
      lineRange: "173-186",
      language: "typescript",
    });
  });

  it("collapses a single-line reference range", () => {
    const fence = parseCodeFenceInfo("42:42:src/app.tsx");
    expect(fence.lineRange).toBe("42");
    expect(fence.language).toBe("tsx");
  });

  it("treats a bare path as an un-ranged file reference", () => {
    const fence = parseCodeFenceInfo("src/index.py");
    expect(fence).toMatchObject({
      isFileReference: true,
      fileName: "index.py",
      directory: "src",
      lineRange: null,
      language: "python",
    });
  });

  it("resolves a language for files without a directory", () => {
    const fence = parseCodeFenceInfo("12:20:Dockerfile");
    expect(fence.isFileReference).toBe(true);
    expect(fence.directory).toBeNull();
    expect(fence.fileName).toBe("Dockerfile");
    expect(fence.language).toBe("dockerfile");
  });

  it("keeps bare language tokens as-is", () => {
    expect(parseCodeFenceInfo("ts")).toMatchObject({
      isFileReference: false,
      language: "ts",
      filePath: null,
    });
  });

  it("falls back to text for an empty info string and maps gitignore to ini", () => {
    expect(parseCodeFenceInfo("").language).toBe("text");
    expect(parseCodeFenceInfo("gitignore").language).toBe("ini");
  });

  it("falls back to text for unknown extensions", () => {
    expect(parseCodeFenceInfo("1:2:notes.unknownext").language).toBe("text");
  });
});

describe("dedentCode", () => {
  it("strips the common leading indentation while keeping relative indentation", () => {
    const input = ["      <div>", "        <span />", "      </div>"].join("\n");
    expect(dedentCode(input)).toBe(["<div>", "  <span />", "</div>"].join("\n"));
  });

  it("ignores blank lines when computing the common indent", () => {
    const input = ["    a();", "", "    b();"].join("\n");
    expect(dedentCode(input)).toBe(["a();", "", "b();"].join("\n"));
  });

  it("is a no-op for already flush-left code", () => {
    const input = ["const x = 1;", "  const y = 2;"].join("\n");
    expect(dedentCode(input)).toBe(input);
  });

  it("leaves single-line snippets untouched when flush", () => {
    expect(dedentCode("const value = 42;")).toBe("const value = 42;");
  });
});
