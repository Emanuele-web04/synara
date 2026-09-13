import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { changedFiles, flags, planChanges, readWorkspaces } from "./ci-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceFixture = [
  ["packages/contracts", "contracts", []],
  ["packages/shared", "shared", ["contracts"]],
  ["apps/web", "web", ["contracts", "shared"]],
  ["apps/server", "cli", ["contracts", "shared", "web"]],
  ["apps/desktop", "desktop", ["contracts", "shared"]],
  ["scripts", "scripts", ["contracts", "shared"]],
  ["apps/marketing", "marketing", []],
].map(([directory, name, dependencies]) => ({
  directory,
  name: `@synara/${name}`,
  dependencies: dependencies.map((dependency) => `@synara/${dependency}`),
}));
const selected = (plan) => flags.filter((flag) => plan[flag]);
const all = [...flags];
const server = ["code", "unit", "build", "windows"];
const desktop = ["code", "build", "windows"];
const scenarios = [
  ["Markdown-only", "README.md", []],
  ["Marketing content", "apps/marketing/content/docs/index.mdx", []],
  ["Web", "apps/web/src/App.tsx", all],
  ["Browser test", "apps/web/src/components/ChatView.browser.tsx", all],
  ["Desktop", "apps/desktop/src/main.ts", desktop],
  ["Server/CLI", "apps/server/src/index.ts", server],
  ["Windows/process", "apps/server/src/platform/processTreeController.ts", server],
  ["Migration", "apps/server/src/persistence/Migrations.ts", server],
  ["Shared", "packages/shared/src/model.ts", all],
  ["Contracts", "packages/contracts/src/index.ts", all],
  ["Lockfile", "bun.lock", all],
  ["CI workflow", ".github/workflows/ci.yml", all],
  ["Release tooling", "scripts/release-smoke.ts", all],
  ["Marketing executable source", "apps/marketing/src/app/docs/page.tsx", ["code"]],
  ["Dependency manifest", "apps/marketing/package.json", all],
  ["Runtime MDX", "apps/web/src/help.mdx", all],
  ["Runtime asset", "apps/web/public/icon.svg", all],
  ["Dependency patch", "patches/runtime.patch", all],
  ["Unknown root config", "new-build.config.ts", all],
  ["Unknown workspace", "apps/future/src/index.ts", all],
];

for (const [name, file, expected] of scenarios) {
  test(`selection: ${name}`, () => {
    assert.deepEqual(selected(planChanges([file], workspaceFixture)), expected);
  });
}

test("main and other non-PR events run everything, including prose changes", () => {
  assert.deepEqual(selected(planChanges(["README.md"], workspaceFixture, true)), all);
  assert.deepEqual(selected(planChanges([], workspaceFixture, true)), all);
});

test("mixed changes take the union, regardless of order", () => {
  for (const files of [
    ["README.md", "apps/server/src/index.ts"],
    ["apps/server/src/index.ts", "README.md"],
  ]) {
    assert.deepEqual(selected(planChanges(files, workspaceFixture)), server);
  }
});

test("new workspace ownership selects full validation", () => {
  const workspaces = [
    ...workspaceFixture,
    { directory: "apps/new", name: "@synara/new", dependencies: [] },
  ];
  assert.deepEqual(selected(planChanges(["apps/new/source.ts"], workspaces)), all);
});

test("transitive consumers and cycles do not lose fan-out", () => {
  const workspaces = structuredClone(workspaceFixture);
  workspaces.find(({ name }) => name === "@synara/web").dependencies.push("@synara/desktop");
  assert.deepEqual(selected(planChanges(["apps/desktop/src/main.ts"], workspaces)), all);
});

test("full matrix preserves web and both serial server shards exactly once", () => {
  const plan = planChanges(["bun.lock"], workspaceFixture);
  assert.deepEqual(
    plan.matrix.include.map(({ pkg }) => pkg),
    ["web", "server 1/2", "server 2/2"],
  );
  assert.deepEqual(
    plan.matrix.include.map((entry) => entry["test-args"]),
    ["", "--shard=1/2", "--shard=2/2"],
  );
  assert.equal(planChanges(["README.md"], workspaceFixture).unit, false);
  assert.equal(planChanges(["README.md"], workspaceFixture).matrix.include.length, 1);
});

test("workspace discovery includes dev, optional and peer dependencies", (context) => {
  const directory = mkdtempSync(resolve(tmpdir(), "synara-ci-workspaces-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(resolve(directory, "apps/consumer"), { recursive: true });
  writeFileSync(
    resolve(directory, "package.json"),
    JSON.stringify({ workspaces: { packages: ["apps/*"] } }),
  );
  writeFileSync(
    resolve(directory, "apps/consumer/package.json"),
    JSON.stringify({
      name: "consumer",
      dependencies: { a: "workspace:*" },
      devDependencies: { b: "workspace:*" },
      optionalDependencies: { c: "workspace:*" },
      peerDependencies: { d: "workspace:*" },
    }),
  );
  assert.deepEqual(readWorkspaces(directory)[0].dependencies, ["a", "b", "c", "d"]);
});

test("git diff includes both rename sides and safely handles unusual filenames", (context) => {
  const directory = mkdtempSync(resolve(tmpdir(), "synara-ci-diff-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.email", "ci-test@example.invalid");
  git("config", "user.name", "CI test");
  const oldFile = "apps/server/src/runtime.ts";
  mkdirSync(resolve(directory, dirname(oldFile)), { recursive: true });
  writeFileSync(resolve(directory, oldFile), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  renameSync(resolve(directory, oldFile), resolve(directory, "README.md"));
  writeFileSync(resolve(directory, "space and\nnewline.md"), "prose\n");
  git("add", "-A");
  git("commit", "-m", "rename runtime to prose");
  const files = changedFiles(directory, base);
  assert.ok(files.includes(oldFile));
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("space and\nnewline.md"));
  assert.deepEqual(selected(planChanges(files, workspaceFixture)), server);
  assert.throws(() => changedFiles(directory, undefined), /base SHA/);
  assert.throws(() => changedFiles(directory, "HEAD; echo unsafe"), /base SHA/);
  assert.throws(() => changedFiles(directory, "0".repeat(40)));
});

const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const gate = workflow
  .split("// BEGIN GATE CONTRACT (executed verbatim by ci-plan.test.mjs)\n")[1]
  ?.split("// END GATE CONTRACT")[0];
assert.ok(gate, "the production aggregate gate must remain testable");
const jobFlags = {
  "static-typecheck": "code",
  unit: "unit",
  browser: "browser",
  build: "build",
  windows_process: "windows",
};
function needsFor(plan) {
  const needs = {
    changes: {
      result: "success",
      outputs: Object.fromEntries(flags.map((flag) => [flag, String(plan[flag])])),
    },
    "static-fast": { result: "success" },
  };
  for (const [job, flag] of Object.entries(jobFlags)) {
    needs[job] = { result: plan[flag] ? "success" : "skipped" };
  }
  return needs;
}
const evaluateGate = (needs) =>
  runInNewContext(gate, { process: { env: { NEEDS: JSON.stringify(needs) } } });

for (const [name, file] of scenarios) {
  test(`gate accepts the exact ${name} plan`, () => {
    evaluateGate(needsFor(planChanges([file], workspaceFixture)));
  });
}

for (const result of ["failure", "cancelled", "skipped", undefined]) {
  for (const job of ["changes", "static-fast", ...Object.keys(jobFlags)]) {
    test(`gate rejects ${job}=${result} when required`, () => {
      const needs = needsFor(planChanges(["bun.lock"], workspaceFixture));
      needs[job].result = result;
      assert.throws(() => evaluateGate(needs), /CI gate failed/);
    });
  }
}

for (const flag of flags) {
  test(`gate rejects missing or malformed ${flag}`, () => {
    for (const value of [undefined, "", "TRUE", "null"]) {
      const needs = needsFor(planChanges(["README.md"], workspaceFixture));
      needs.changes.outputs[flag] = value;
      assert.throws(() => evaluateGate(needs), /Invalid plan flag/);
    }
  });
}

test("gate rejects a failed, cancelled or unexpectedly executed unselected lane", () => {
  for (const result of ["failure", "cancelled", "success"]) {
    const needs = needsFor(planChanges(["README.md"], workspaceFixture));
    needs.browser.result = result;
    assert.throws(() => evaluateGate(needs), /browser: expected skipped/);
  }
});

test("required name, selection wiring and migration history remain enforced", () => {
  assert.ok(workflow.includes("name: Format, Lint, Typecheck, Test, Browser Test, Build\n"));
  assert.ok(workflow.includes("if: always()"));
  assert.ok(workflow.includes("fetch-depth: 0"));
  assert.ok(workflow.includes("grep -q '^Migration lineage check passed:'"));
  assert.ok(workflow.includes("node --test .github/scripts/*.test.mjs"));
  assert.equal((workflow.match(/run: bun run brand:check/g) ?? []).length, 1);
  assert.equal((workflow.match(/run: bun run windows-runtime:check/g) ?? []).length, 1);
  assert.ok(!workflow.includes("continue-on-error"));
  for (const [job, flag] of Object.entries(jobFlags)) {
    const section = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z_-]+:\n/)[0];
    assert.ok(
      section?.includes(`if: needs.changes.outputs.${flag} == 'true'`),
      `${job} must use ${flag}`,
    );
  }
});

// The fixture tests are runnable without installing or downloading the workspace.
// CI additionally checks minimum fan-out against the actual checked-out manifests.
test(
  "real workspace manifests preserve required scenario fan-out",
  { skip: !existsSync(resolve(root, "package.json")) },
  () => {
    const workspaces = readWorkspaces(root);
    for (const [name, file, expected] of scenarios) {
      const actual = planChanges([file], workspaces);
      for (const flag of expected) assert.equal(actual[flag], true, `${name} must select ${flag}`);
    }
  },
);
