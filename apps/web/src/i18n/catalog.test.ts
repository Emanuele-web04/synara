import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import spanish from "./locales/es.json";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const catalog: Record<string, string> = spanish;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(file) : [file];
    })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser|spec)\.|routeTree\.gen/.test(file));
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!).toSorted();
}

describe("Spanish catalog", () => {
  it("keeps every interpolation value and avoids empty translations", () => {
    const invalid: string[] = [];
    for (const [source, translation] of Object.entries(catalog)) {
      if (
        !translation.trim() ||
        JSON.stringify(placeholders(source)) !== JSON.stringify(placeholders(translation))
      )
        invalid.push(source);
    }
    expect(invalid).toEqual([]);
  });

  it("covers the application's explicit messages and keeps translation calls out of module initialization", () => {
    const missing: string[] = [];
    const frozen: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
      const contents = readFileSync(file, "utf8");
      if (!/from\s*["'][^"']*i18n/.test(contents)) continue;
      const ast = ts.createSourceFile(
        file,
        contents,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ["t", "translate"].includes(node.expression.text)
        ) {
          const message = node.arguments[0];
          if (
            message &&
            (ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message))
          ) {
            const location = `${path.relative(sourceRoot, file)}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`;
            if (!Object.hasOwn(catalog, message.text)) missing.push(`${location}: ${message.text}`);
            let parent: ts.Node | undefined = node.parent;
            while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
            if (!parent) frozen.push(location);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(missing).toEqual([]);
    expect(frozen).toEqual([]);
  });
});
