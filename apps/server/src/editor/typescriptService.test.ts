import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EditorIntelligenceInput } from "@synara/contracts";
import { createTypeScriptService } from "./typescriptService";
import { EditorLanguageService } from "./languageService";

let temporary: string;
let root: string;
let compiler: ReturnType<typeof createTypeScriptService>;
let documents: EditorIntelligenceInput["documents"];
const math =
  "/** Add two values. */\nexport function add(left: number, right: number) {\n  return left + right;\n}\nexport interface Item { value: number }\nexport const item: Item = { value: 1 };\n";
const main =
  "import { add, item } from './math';\nconst answer = add(1, 2);\nanswer.toFixed(2);\nitem.value;\n";
const call = main.indexOf("add(1");
function request(
  operation: EditorIntelligenceInput["operation"],
  options: Partial<EditorIntelligenceInput> = {},
) {
  return compiler.request({
    cwd: root,
    relativePath: "main.ts",
    documents,
    operation,
    offset: call,
    length: 0,
    ...options,
  });
}
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "synara-language-"));
  root = path.join(temporary, "workspace");
  await mkdir(root);
  await writeFile(path.join(root, "math.ts"), math);
  await writeFile(path.join(root, "main.ts"), main);
  documents = [
    { relativePath: "main.ts", contents: main, version: 1 },
    { relativePath: "math.ts", contents: math, version: 1 },
  ];
  compiler = createTypeScriptService(root);
});
afterEach(async () => {
  compiler.dispose();
  await rm(temporary, { recursive: true, force: true });
});

describe("real TypeScript project intelligence", () => {
  it.each(["class", "return", "null", "true", "let", "yield", "await", "123 invalid", "bad-name"])(
    "rejects renaming a variable binding to %s without changing disk",
    async (newName) => {
      expect(() => request("rename", { offset: main.indexOf("answer ="), newName })).toThrow(
        "valid identifier",
      );
      expect(await readFile(path.join(root, "main.ts"), "utf8")).toBe(main);
    },
  );

  it.each(["type", "async", "get", "$value", "café"])(
    "retains valid contextual and Unicode binding names: %s",
    (newName) => {
      expect(
        request("rename", { offset: main.indexOf("answer ="), newName }).edits?.[0]?.edits,
      ).toEqual(expect.arrayContaining([expect.objectContaining({ newText: newName })]));
    },
  );

  it("allows reserved property names and preserves pre-existing syntax errors", () => {
    expect(
      request("rename", {
        relativePath: "math.ts",
        offset: math.indexOf("value: number"),
        newName: "class",
      }).edits?.length,
    ).toBeGreaterThan(0);
    documents = [
      { relativePath: "main.ts", contents: main + "const incomplete = ;\n", version: 2 },
    ];
    expect(
      request("rename", { offset: main.indexOf("answer ="), newName: "renamed" }).edits?.length,
    ).toBeGreaterThan(0);
  });

  it("provides completion documentation, signature help, navigation, references, symbols, and a read-only rename transaction", async () => {
    expect(
      request("completion", {
        offset: main.indexOf("answer.to") + "answer.".length,
      }).completions?.some((item) => item.label === "toFixed"),
    ).toBe(true);
    expect(
      request("completionResolve", {
        offset: main.indexOf("answer.to") + "answer.".length,
        query: "toFixed",
      }).text,
    ).toContain("toFixed");
    expect(request("hover").text).toContain("Add two values");
    expect(request("signature", { offset: call + "add(1,".length }).activeParameter).toBe(1);
    expect(request("definition").locations?.[0]?.relativePath).toBe("math.ts");
    expect(
      request("typeDefinition", { offset: main.lastIndexOf("item.value") }).locations?.[0]
        ?.relativePath,
    ).toBe("math.ts");
    expect(new Set(request("references").locations?.map((item) => item.relativePath))).toEqual(
      new Set(["main.ts", "math.ts"]),
    );
    const answer = request("documentSymbols").symbols?.find((symbol) => symbol.name === "answer");
    expect(answer).toBeDefined();
    // The extent spans the whole declaration so outlines and sticky headers can enclose it.
    expect(answer!.extent!.length).toBeGreaterThan(answer!.location.length);
    expect(
      request("workspaceSymbols", { query: "add" }).symbols?.some(
        (symbol) => symbol.name === "add",
      ),
    ).toBe(true);
    // Renaming an import use preserves the exported API and introduces a local alias.
    const alias = request("rename", { newName: "sum" }).edits;
    expect(alias).toHaveLength(1);
    expect(alias?.[0]?.relativePath).toBe("main.ts");
    expect(alias?.[0]?.edits.some((edit) => edit.newText === "add as sum")).toBe(true);
    const renamed = request("rename", {
      relativePath: "math.ts",
      offset: math.indexOf("add("),
      newName: "sum",
    }).edits;
    expect(renamed?.length).toBe(2);
    expect(
      renamed?.every(
        (file) => file.expectedContents === (file.relativePath === "main.ts" ? main : math),
      ),
    ).toBe(true);
    expect(renamed?.every((file) => file.edits.some((edit) => edit.newText === "sum"))).toBe(true);
    expect(await readFile(path.join(root, "math.ts"), "utf8")).toBe(math);
  });

  it("uses unsaved dependencies and never confuses reopened model version numbers", () => {
    documents = [
      { relativePath: "main.ts", contents: main, version: 1 },
      {
        relativePath: "math.ts",
        contents: math.replace("return left + right", "return String(left + right)"),
        version: 1,
      },
    ];
    expect(request("diagnostics").diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 2551,
          message: expect.stringContaining("does not exist on type 'string'"),
        }),
      ]),
    );
    documents = [
      { relativePath: "main.ts", contents: main, version: 1 },
      { relativePath: "math.ts", contents: math, version: 1 },
    ];
    expect(request("diagnostics").diagnostics?.filter((item) => item.severity === "error")).toEqual(
      [],
    );
  });

  it("returns real quick fixes, formatting/import edits, inlay hints, and folding ranges", () => {
    const code =
      "import { add, item } from './math';\nconst text = 'hello';\ntext.toUppercase();\nfunction greet(name:string){\nreturn 'hello '+name;\n}\nadd(1,2);\n";
    documents = [
      { relativePath: "main.ts", contents: code, version: 2 },
      { relativePath: "math.ts", contents: math, version: 1 },
    ];
    const diagnostics = request("diagnostics", { offset: 0 }).diagnostics ?? [];
    const spelling = diagnostics.find((item) => item.message.includes("toUpperCase"));
    expect(spelling).toBeDefined();
    const actions = request("codeActions", {
      offset: spelling!.start,
      length: spelling!.length,
    }).actions;
    expect(
      actions?.some((action) =>
        action.edits.some((file) =>
          file.edits.some((edit) => edit.newText.includes("toUpperCase")),
        ),
      ),
    ).toBe(true);
    expect(request("format", { offset: 0 }).edits?.[0]?.edits.length).toBeGreaterThan(0);
    expect(request("organizeImports", { offset: 0 }).edits?.[0]?.edits.length).toBeGreaterThan(0);
    expect(
      request("inlayHints", { offset: 0 }).hints?.some((hint) => hint.kind === "parameter"),
    ).toBe(true);
    expect(request("folding", { offset: 0 }).folding?.length).toBeGreaterThan(0);
  });

  it("honors the nearest package tsconfig in a monorepo", async () => {
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strictNullChecks: false } }),
    );
    await mkdir(path.join(root, "package"));
    await writeFile(
      path.join(root, "package", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strictNullChecks: true } }),
    );
    const code = "const value: number = null;\n";
    await writeFile(path.join(root, "package", "index.ts"), code);
    documents = [{ relativePath: "package/index.ts", contents: code, version: 1 }];
    expect(
      request("diagnostics", { relativePath: "package/index.ts", offset: 0 }).diagnostics?.some(
        (item) => item.code === 2322,
      ),
    ).toBe(true);
  });

  it.each([undefined, false])(
    "supports loose JavaScript beside a TS-only project (allowJs: %s) without changing TS options",
    async (allowJs) => {
      await writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, allowJs }, include: ["*.ts"] }),
      );
      const javascript = 'const text = "hello";\ntext.toUppercase();\n';
      const typescript = "const value: number = null;\n";
      await writeFile(path.join(root, "debug.js"), javascript);
      documents = [
        { relativePath: "main.ts", contents: typescript, version: 2 },
        { relativePath: "debug.js", contents: javascript, version: 1 },
      ];
      const js = { relativePath: "debug.js", offset: javascript.indexOf("text.to") + 5 };
      for (let index = 0; index < 2; index++) {
        expect(
          request("completion", js).completions?.some((item) => item.label === "toUpperCase"),
        ).toBe(true);
        expect(request("diagnostics", js).diagnostics?.some((item) => item.code === 2551)).toBe(
          true,
        );
        expect(
          request("diagnostics", { offset: 0 }).diagnostics?.some((item) => item.code === 2322),
        ).toBe(true);
      }
      expect(JSON.parse(await readFile(path.join(root, "tsconfig.json"), "utf8"))).toEqual({
        compilerOptions: { strict: true, ...(allowJs === undefined ? {} : { allowJs }) },
        include: ["*.ts"],
      });
    },
  );

  it("preserves explicit configured JavaScript checking policy", async () => {
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false } }),
    );
    const code = 'const text = "hello";\ntext.toUppercase();\n';
    await writeFile(path.join(root, "debug.js"), code);
    documents = [{ relativePath: "debug.js", contents: code, version: 1 }];
    expect(request("diagnostics", { relativePath: "debug.js", offset: 0 }).diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 2551 })]),
    );
  });

  it("rejects traversal and symlink escapes instead of reading outside the workspace", async () => {
    expect(() => request("hover", { relativePath: "../outside.ts" })).toThrow("workspace");
    if (process.platform !== "win32") {
      const outside = path.join(temporary, "outside.ts");
      await writeFile(outside, "export const secret = 42;");
      await symlink(outside, path.join(root, "linked.ts"));
      expect(() =>
        request("hover", {
          documents: [{ relativePath: "linked.ts", contents: "", version: 1 }],
          relativePath: "linked.ts",
          offset: 0,
        }),
      ).toThrow("workspace");
    }
  });

  it("executes the same compiler across an actual worker boundary and rejects already-cancelled requests", async () => {
    const service = new EditorLanguageService();
    try {
      const input: EditorIntelligenceInput = {
        cwd: root,
        relativePath: "main.ts",
        documents,
        operation: "hover",
        offset: call,
        length: 0,
      };
      expect((await service.request("owner", input)).text).toContain("Add two values");
      await expect(service.request("owner", input, AbortSignal.abort())).rejects.toThrow(
        "cancelled",
      );
    } finally {
      service.dispose();
    }
  });
});
