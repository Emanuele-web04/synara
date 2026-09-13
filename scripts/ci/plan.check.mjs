// Tests use Node directly so CI admission does not require a workspace install.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { changedFiles, isProse, planChanges, readWorkspaces } from "./plan.mjs";

const workspace = (directory, name, dependencies = [], hasTests = true) => ({
  directory, name: `@synara/${name}`, dependencies: dependencies.map((dep) => `@synara/${dep}`), test: hasTests,
});
const graph = [
  workspace("packages/contracts", "contracts"),
  workspace("packages/shared", "shared", ["contracts"]),
  workspace("scripts", "scripts", ["contracts", "shared"]),
  workspace("apps/desktop", "desktop", ["contracts", "shared"]),
  workspace("apps/web", "web", ["contracts", "shared"]),
  workspace("apps/server", "cli", ["contracts", "shared", "web"]),
  workspace("apps/marketing", "marketing", [], false),
];
const keys = ["typecheck", "product", "unit", "browser", "build", "windows"];
const scenarios = [
  ["Markdown only", "README.md", [false, false, false, false, false, false], ["core"]],
  ["Marketing content", "apps/marketing/content/docs/start.mdx", [true, false, false, false, false, false], ["core"]],
  ["Web", "apps/web/src/routes/index.tsx", [true, true, true, true, true, true], ["core", "web", "server 1/2", "server 2/2"]],
  ["Browser test", "apps/web/src/components/ChatView.browser.tsx", [true, true, true, true, true, true], ["core", "web", "server 1/2", "server 2/2"]],
  ["Desktop", "apps/desktop/src/main.ts", [true, true, true, true, true, true], ["core"]],
  ["Server CLI", "apps/server/src/index.ts", [true, true, true, false, true, true], ["core", "server 1/2", "server 2/2"]],
  ["Windows process", "packages/shared/src/processRuntime.ts", [true, true, true, true, true, true], ["core", "web", "server 1/2", "server 2/2"]],
  ["Migration", "apps/server/src/persistence/Migrations.ts", [true, true, true, false, true, true], ["core", "server 1/2", "server 2/2"]],
  ["Shared", "packages/shared/src/model.ts", [true, true, true, true, true, true], ["core", "web", "server 1/2", "server 2/2"]],
  ["Contracts", "packages/contracts/src/index.ts", [true, true, true, true, true, true], ["core", "web", "server 1/2", "server 2/2"]],
  ["Dependencies", "bun.lock", [true, true, true, true, true, true], ["core", "web", "server 1/2", "server 2/2"]],
  ["CI workflow", ".github/workflows/ci.yml", [true, true, true, true, true, true], ["core", "web", "server 1/2", "server 2/2"]],
  ["Release tooling", "scripts/release-smoke.ts", [true, true, true, true, true, true], ["core", "web", "server 1/2", "server 2/2"]],
];
for (const [name, file, flags, matrix] of scenarios) {
  test(name, () => {
    const plan = planChanges([file], graph);
    assert.deepEqual(keys.map((key) => plan[key]), flags);
    assert.deepEqual(plan.unit_matrix.include.map((entry) => entry.pkg), matrix);
  });
}

test("Unknown files, package manifests and dependency patches select full validation", () => {
  for (const file of ["new-root/tool.ts", "apps/new/feature.ts", "apps/web/package.json", "patches/runtime.patch", "docs/example.ts", "turbo.json"]) {
    const plan = planChanges([file], graph);
    assert.ok(plan.full, file);
    assert.ok(keys.every((key) => plan[key]), file);
  }
});

test("Runtime Markdown and mixed docs/code are not a docs-only bypass", () => {
  assert.equal(isProse("apps/server/src/prompts/system.md"), false);
  assert.ok(planChanges(["README.md", "apps/server/src/prompts/system.md"], graph).windows);
  assert.ok(planChanges(["README.md", "apps/web/src/view.mdx"], graph).browser);
});

test("Reverse dependencies include transitive build/test edges and tolerate cycles", () => {
  const extended = graph.map((pkg) => ({ ...pkg, dependencies: [...pkg.dependencies] }));
  extended.find((pkg) => pkg.name === "@synara/web").dependencies.push("@synara/desktop");
  extended.find((pkg) => pkg.name === "@synara/desktop").dependencies.push("@synara/cli");
  const plan = planChanges(["apps/desktop/src/preload.ts"], extended);
  assert.ok(plan.affected.includes("@synara/cli"));
  assert.ok(plan.unit_matrix.include.some((entry) => entry.pkg === "web"));
});

test("New workspaces cannot silently bypass broad validation or core tests", () => {
  const extended = [...graph, workspace("packages/new", "new")];
  const plan = planChanges(["packages/new/src/index.ts"], extended);
  assert.ok(plan.full);
  assert.match(plan.unit_matrix.include[0].filters, /--filter=@synara\/new/);
});

test("Main and manual runs validate everything, even with no changed files", () => {
  assert.ok(keys.every((key) => planChanges([], graph, true)[key]));
});

test("Real workspace manifests match the current routing expectations", () => {
  const root = resolve(import.meta.dirname, "../..");
  const actual = readWorkspaces(root);
  for (const [, file, flags, matrix] of scenarios) {
    const plan = planChanges([file], actual);
    assert.deepEqual(keys.map((key) => plan[key]), flags, file);
    assert.deepEqual(plan.unit_matrix.include.map((entry) => entry.pkg), matrix, file);
  }
});

test("Manifest reader includes every dependency section and rejects unsupported patterns", () => {
  const root = mkdtempSync(resolve(tmpdir(), "synara-ci-manifests-"));
  try {
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ workspaces: { packages: ["apps/*", "packages/*", "scripts"] } }));
    for (const pkg of graph) {
      mkdirSync(resolve(root, pkg.directory), { recursive: true });
      writeFileSync(resolve(root, pkg.directory, "package.json"), JSON.stringify({
        name: pkg.name, scripts: pkg.test ? { test: "vitest run" } : {},
        devDependencies: Object.fromEntries(pkg.dependencies.map((name) => [name, "workspace:*"])),
        optionalDependencies: { "@synara/optional": "workspace:*" },
        peerDependencies: { "@synara/peer": "workspace:*" },
      }));
    }
    const actual = readWorkspaces(root);
    assert.ok(actual.every((pkg) => pkg.dependencies.includes("@synara/optional") && pkg.dependencies.includes("@synara/peer")));
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ workspaces: ["**"] }));
    assert.throws(() => readWorkspaces(root), /Unsupported workspace pattern/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NUL-delimited diff preserves deletion/rename sources and unusual filenames", () => {
  const root = mkdtempSync(resolve(tmpdir(), "synara-ci-diff-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.email", "ci-test@example.invalid");
    git("config", "user.name", "CI test fixture");
    mkdirSync(resolve(root, "packages/shared"), { recursive: true });
    writeFileSync(resolve(root, "packages/shared/runtime.ts"), "same contents\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("mv", "packages/shared/runtime.ts", "README.md");
    writeFileSync(resolve(root, "unusual\nfilename.ts"), "export {};\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "rename");
    const files = changedFiles(root, base);
    assert.ok(files.includes("packages/shared/runtime.ts"));
    assert.ok(files.includes("unusual\nfilename.ts"));
    assert.ok(planChanges(files, graph).full);
    assert.throws(() => changedFiles(root, "0".repeat(40)));
    assert.throws(() => changedFiles(root, "--bad-option"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
