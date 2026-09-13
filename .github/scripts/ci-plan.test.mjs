import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  affectedPackages,
  fullPlan,
  planChanges,
  planForEvent,
  readGraph,
  workspacePaths,
} from "./ci-plan.mjs";

// Real manifest edges, including the implicit desktop packaging dependency.
const graph = {
  "@synara/contracts": [],
  "@synara/shared": ["@synara/contracts"],
  "@synara/web": ["@synara/contracts", "@synara/shared"],
  "@synara/cli": ["@synara/contracts", "@synara/shared", "@synara/web"],
  "@synara/desktop": ["@synara/contracts", "@synara/shared", "@synara/cli"],
  "@synara/scripts": ["@synara/contracts", "@synara/shared"],
  "@synara/marketing": [],
};
const flags = ["typecheck", "unit", "browser", "build", "windows", "migrations"];
const all = flags.join(",");
const scenarios = [
  ["Markdown", "README.md", "", []],
  ["Marketing content", "apps/marketing/content/docs/index.mdx", "", []],
  [
    "Web",
    "apps/web/src/store.ts",
    "typecheck,unit,browser,build,windows",
    ["core", "web", "server 1/2", "server 2/2"],
  ],
  [
    "Browser test",
    "apps/web/src/components/ChatView.browser.tsx",
    "typecheck,unit,browser,build,windows",
    ["core", "web", "server 1/2", "server 2/2"],
  ],
  ["Desktop", "apps/desktop/src/main.ts", "typecheck,unit,build,windows", ["core"]],
  [
    "Server/CLI",
    "apps/server/src/http.ts",
    "typecheck,unit,build,windows",
    ["core", "server 1/2", "server 2/2"],
  ],
  ["Windows/process runtime", "packages/shared/src/processRuntime.ts", all],
  [
    "Migration",
    "apps/server/src/persistence/Migrations.ts",
    "typecheck,unit,build,windows,migrations",
    ["core", "server 1/2", "server 2/2"],
  ],
  ["Shared", "packages/shared/src/model.ts", all],
  ["Contracts", "packages/contracts/src/index.ts", all],
  ["Lockfile", "bun.lock", all],
  ["Workflow", ".github/workflows/ci.yml", all],
  ["Release tooling", "scripts/release-smoke.ts", all],
];
for (const [name, path, enabled, rows] of scenarios) {
  test(`${name}: only explicitly affected lanes run`, () => {
    const plan = planChanges([path], graph);
    assert.equal(flags.filter((flag) => plan[flag]).join(","), enabled);
    if (rows)
      assert.deepEqual(
        plan.matrix.include.map((row) => row.pkg),
        rows,
      );
  });
}

test("Unknown paths, package manifests and runtime documentation run validation", () => {
  for (const path of [
    "package.json",
    "patches/runtime.patch",
    "new-app/index.ts",
    "apps/web/package.json",
    ".github/scripts/ci-plan.mjs",
  ]) {
    assert.equal(
      flags.every((flag) => planChanges([path], graph)[flag]),
      true,
      path,
    );
  }
  assert.equal(planChanges(["apps/server/src/prompt.md"], graph).windows, true);
  assert.equal(planChanges(["apps/web/src/help.mdx"], graph).browser, true);
  assert.equal(planChanges(["apps/marketing/src/app/page.tsx"], graph).typecheck, true);
  assert.equal(
    flags.every((flag) => planChanges([], graph)[flag]),
    true,
  );
});

test("Fan-out follows all reverse dependencies and terminates with cycles", () => {
  const extended = structuredClone(graph);
  extended["@synara/web"].push("@synara/desktop");
  extended["@synara/cli"].push("@synara/marketing");
  assert.equal(planChanges(["apps/desktop/src/main.ts"], extended).browser, true);
  assert.equal(planChanges(["apps/marketing/content/docs/index.mdx"], extended).windows, true);
  assert.equal(affectedPackages(["@synara/shared"], graph).size, 5);
});

test("Large and mixed changes do not truncate the affected change set", () => {
  const paths = Array.from({ length: 3100 }, (_, i) => `docs/${i}.md`);
  paths.push("packages/shared/src/processRuntime.ts");
  assert.equal(
    flags.every((flag) => planChanges(paths, graph)[flag]),
    true,
  );
  assert.equal(planChanges(["README.md", "apps/server/src/http.ts"], graph).windows, true);
});

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "synara-ci-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "CI test");
  git(root, "config", "user.email", "ci-test@example.invalid");
  write(
    root,
    "package.json",
    JSON.stringify({ workspaces: { packages: ["apps/*", "packages/*", "scripts"] } }),
  );
  for (const [name, path] of Object.entries(workspacePaths)) {
    const dependencies = graph[name].filter(
      (dependency) => !(name === "@synara/desktop" && dependency === "@synara/cli"),
    );
    write(
      root,
      `${path}/package.json`,
      JSON.stringify({
        name,
        devDependencies: Object.fromEntries(dependencies.map((name) => [name, "workspace:*"])),
      }),
    );
  }
  write(root, "apps/server/src/persistence/Migrations.ts", "released migration");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

test("Read real manifest dependency kinds and reject a changed inventory", (t) => {
  const root = fixture(t);
  assert.deepEqual(readGraph(root), graph);
  write(root, "apps/new/package.json", '{"name":"@synara/new"}');
  git(root, "add", ".");
  assert.throws(() => readGraph(root), /inventory/);
});

test("Git merge diff includes deletes and both sides of renames", (t) => {
  const root = fixture(t);
  git(root, "checkout", "-b", "feature");
  mkdirSync(join(root, "docs"));
  git(root, "mv", "apps/server/src/persistence/Migrations.ts", "docs/moved.md");
  git(root, "commit", "-m", "move runtime file into docs");
  git(root, "checkout", "main");
  git(root, "merge", "--no-ff", "feature", "-m", "tested merge");
  const plan = planForEvent(root, "pull_request", "refs/pull/1/merge");
  assert.equal(plan.migrations, true);
  assert.equal(plan.windows, true);
  assert.equal(plan.browser, false);
});

test("Main, non-merge checkouts and broken graphs fail open to full validation", (t) => {
  const root = fixture(t);
  for (const [event, ref] of [
    ["push", "refs/heads/main"],
    ["pull_request", "refs/pull/1/head"],
    ["pull_request", "refs/pull/1/merge"],
  ]) {
    assert.equal(
      flags.every((flag) => planForEvent(root, event, ref)[flag]),
      true,
    );
  }
});

// Execute the EXACT aggregator embedded in the workflow, not a second model.
const workflow = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
const gate = workflow.match(/          node <<'NODE'\n([\s\S]*?)\n          NODE/)[1];
const laneFlags = {
  "static-typecheck": "typecheck",
  unit: "unit",
  browser: "browser",
  build: "build",
  windows_process: "windows",
  migration_lineage: "migrations",
};
function needsFor(plan) {
  const needs = {
    changes: {
      result: "success",
      outputs: Object.fromEntries(flags.map((flag) => [flag, String(plan[flag])])),
    },
    "static-fast": { result: "success" },
  };
  for (const [lane, flag] of Object.entries(laneFlags))
    needs[lane] = { result: plan[flag] ? "success" : "skipped" };
  return needs;
}
function gateStatus(needs) {
  return spawnSync(process.execPath, ["-e", gate], {
    env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) },
  }).status;
}
test("Gate accepts only successful required lanes and intentional skips", () => {
  for (const [, path] of scenarios)
    assert.equal(gateStatus(needsFor(planChanges([path], graph))), 0);
  assert.equal(gateStatus(needsFor(fullPlan("test"))), 0);
});
test("Gate rejects failures, cancellations, unexpected skips and missing plans", () => {
  const passing = needsFor(fullPlan("test"));
  for (const lane of Object.keys(passing)) {
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const needs = structuredClone(passing);
      needs[lane].result = result;
      assert.notEqual(gateStatus(needs), 0, `${lane}: ${result}`);
    }
  }
  for (const flag of flags) {
    for (const invalid of ["", "yes", undefined]) {
      const needs = structuredClone(passing);
      needs.changes.outputs[flag] = invalid;
      assert.notEqual(gateStatus(needs), 0, `${flag}: ${invalid}`);
    }
  }
  const optionalFailure = needsFor(planChanges(["README.md"], graph));
  optionalFailure.browser.result = "failure";
  assert.notEqual(gateStatus(optionalFailure), 0);
});
test("Workflow retains the gate name, native checks, partitions and frozen installs", () => {
  assert.match(workflow, /name: Format, Lint, Typecheck, Test, Browser Test, Build\n/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /continue-on-error|bun test\b|release_smoke:/);
  for (const flag of flags)
    assert.match(workflow, new RegExp(`needs.changes.outputs.${flag} == 'true'`));
  for (const name of [
    "backendShutdown.windows.integration.test.ts",
    "MigrationBackup.test.ts",
    "MigrationReplay.test.ts",
    "windowsProcessEffect.test.ts",
  ])
    assert.ok(workflow.includes(name));
  const setup = readFileSync(
    new URL("../actions/setup-workspace/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    readFileSync(new URL("./ci-install.mjs", import.meta.url), "utf8"),
    /"install", "--frozen-lockfile"/,
  );
  assert.match(setup, /runner.os != 'Windows' && steps.modules.outputs.cache-hit != 'true'/);
});
