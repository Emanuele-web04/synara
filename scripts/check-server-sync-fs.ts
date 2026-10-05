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
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
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
  return Object.entries(countSyncFsReferences(source)).flatMap(([name, count]) =>
    count <= (exception?.reason.trim() ? (exception.references[name] ?? 0) : 0)
      ? []
      : [
          `${file}: ${name} has ${count} references; allowed ${exception?.references[name] ?? 0}. Use async fs/Effect FileSystem or justify a narrowly scoped exception.`,
        ],
  );
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
  const violations = serverSources(path.join(root, "apps/server/src")).flatMap((file) =>
    syncFsViolations(
      path.relative(root, file).replaceAll("\\", "/"),
      fs.readFileSync(file, "utf8"),
      budget,
    ),
  );
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else console.log("Server synchronous filesystem budget passed.");
}
