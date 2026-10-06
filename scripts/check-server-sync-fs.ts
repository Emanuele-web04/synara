// Prevent new main-thread filesystem blocking without banning harmless Node builtins.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

export type SyncFsBudget = Readonly<
  Record<
    string,
    {
      readonly reason: string;
      readonly references: Readonly<Record<string, number>>;
    }
  >
>;

export function countSyncFsReferences(source: string): Record<string, number> {
  const ast = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const namespaces = new Set<string>();
  const named = new Map<string, string>();
  const counts: Record<string, number> = {};
  const count = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  for (const node of ast.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !["fs", "node:fs"].includes(node.moduleSpecifier.text) ||
      node.importClause?.isTypeOnly
    )
      continue;
    const clause = node.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && name.endsWith("Sync")) named.set(element.name.text, name);
      }
    }
  }
  // Resolve simple namespace aliases to a fixed point, including aliases declared
  // before their source. This is a syntax guard, not interprocedural type analysis.
  let addedAlias = true;
  while (addedAlias) {
    addedAlias = false;
    const alias = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        namespaces.has(node.initializer.text) &&
        !namespaces.has(node.name.text)
      ) {
        namespaces.add(node.name.text);
        addedAlias = true;
      }
      ts.forEachChild(node, alias);
    };
    alias(ast);
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      ["fs", "node:fs"].includes(node.moduleReference.expression.text)
    ) {
      count("non-static fs import");
      return;
    }
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument) && namespaces.has(argument.text))
          count("fs namespace escape");
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      ["fs", "node:fs"].includes(node.arguments[0].text) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      count("non-static fs import");
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ["fs", "node:fs"].includes(node.moduleSpecifier.text)
    )
      count("fs re-export");
    if (ts.isIdentifier(node) && named.has(node.text)) count(named.get(node.text)!);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      if (node.name.text.endsWith("Sync")) count(node.name.text);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteralLike(argument)) {
        if (argument.text.endsWith("Sync")) count(argument.text);
      } else count("dynamic fs access");
    }
    // A destructured namespace can otherwise hide synchronous methods from the guard.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      namespaces.has(node.initializer.text) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if (ts.isIdentifier(key) && key.text.endsWith("Sync")) count(key.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return counts;
}

export function syncFsViolations(file: string, source: string, budget: SyncFsBudget): string[] {
  const exception = budget[file];
  const actual = countSyncFsReferences(source);
  return [
    ...new Set([...Object.keys(actual), ...Object.keys(exception?.references ?? {})]),
  ].flatMap((name) => {
    const count = actual[name] ?? 0;
    const expected = exception?.reason.trim() ? (exception.references[name] ?? 0) : 0;
    if (count === expected) return [];
    return [
      count < expected
        ? `${file}: stale ${name} budget (${expected} expected, ${count} present). Reduce the budget when removing sync references.`
        : `${file}: ${name} has ${count} references; allowed ${expected}. Use async fs/Effect FileSystem or justify a narrowly scoped exception.`,
    ];
  });
}

export function serverSources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (["fixtures", "testing", "__tests__"].includes(entry.name)) return [];
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return serverSources(file);
    return /\.tsx?$/.test(file) && !/\.(test|spec)(-d)?\.tsx?$/.test(file) ? [file] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "..");
  const budget = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "server-sync-fs-budget.json"), "utf8"),
  ) as SyncFsBudget;
  const sources = ["apps/server/src", "packages/shared/src"].flatMap((directory) =>
    serverSources(path.join(root, directory)),
  );
  const violations = sources.flatMap((file) =>
    syncFsViolations(
      path.relative(root, file).replaceAll("\\", "/"),
      fs.readFileSync(file, "utf8"),
      budget,
    ),
  );
  const present = new Set(sources.map((file) => path.relative(root, file).replaceAll("\\", "/")));
  for (const file of Object.keys(budget))
    if (!present.has(file)) violations.push(`${file}: stale budget for a removed source file.`);
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else console.log("Server synchronous filesystem budget passed.");
}
