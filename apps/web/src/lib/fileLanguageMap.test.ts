// Keeps the lightweight filename→language mirror identical to the diff library's.
import { EXTENSION_TO_FILE_FORMAT, getFiletypeFromFileName } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import { FILE_NAME_TO_LANGUAGE, resolveLanguageFromFileName } from "./fileLanguageMap";

describe("resolveLanguageFromFileName", () => {
  it("mirrors the diff renderer's filename map entry for entry", () => {
    expect(FILE_NAME_TO_LANGUAGE).toEqual(EXTENSION_TO_FILE_FORMAT);
  });

  it("resolves every mapped name and extension like the diff renderer", () => {
    for (const key of Object.keys(EXTENSION_TO_FILE_FORMAT)) {
      for (const fileName of [key, `file.${key}`, `dir.name/file.${key}`]) {
        expect(resolveLanguageFromFileName(fileName), fileName).toBe(
          getFiletypeFromFileName(fileName),
        );
      }
    }
  });

  it("matches the diff renderer on exact names, compound extensions and unknowns", () => {
    for (const fileName of [
      "Dockerfile",
      "CMakeLists.txt",
      "app.component.html",
      "view.blade.php",
      "build.gradle",
      "script.pl",
      "run.bat",
      "Contract.sol",
      "main.jl",
      "header.h",
      "deploy.sh",
      "archive.tar.gz",
      "README",
      ".gitignore",
      "UPPER.TS",
      "no-extension.",
    ]) {
      expect(resolveLanguageFromFileName(fileName), fileName).toBe(
        getFiletypeFromFileName(fileName),
      );
    }
  });

  it("falls back to text for names that only exist on Object.prototype", () => {
    expect(resolveLanguageFromFileName("constructor")).toBe("text");
    expect(resolveLanguageFromFileName("file.toString")).toBe("text");
  });
});
