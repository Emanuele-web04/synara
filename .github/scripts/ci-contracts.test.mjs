import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { compilerCacheFingerprint } from "../../apps/web/scripts/compiler-cache-key.ts";
import { changedPaths, hasCodeChanges, isDocsPath } from "./detect-code-changes.mjs";
import { checkBudget } from "./job-budget.mjs";
import { lockfilePackageFingerprint } from "./lockfile-package-key.mjs";
import { workspaceInstallFingerprint } from "../../scripts/ci-install-key.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = read("../workflows/ci.yml");
const requireFromScripts = createRequire(new URL("../../scripts/package.json", import.meta.url));
const { env: workflowEnv, jobs } = requireFromScripts("yaml").parse(workflow);
const setup = read("../actions/setup-workspace/action.yml");
const gate = workflow.match(
  /- name: Aggregate lane results[\s\S]*?        run: \|\n([\s\S]*?)(?=\n  [a-z_]+:|$)/,
)?.[1];
assert.ok(gate, "The actual aggregate shell must be covered, not a separate approximation");
const code = gate
  .split("\n")
  .map((line) => line.replace(/^          /, ""))
  .join("\n");
const lanes = ["TYPECHECK", "UNIT", "BROWSER", "BUILD", "WINDOWS_PROCESS"];
const heavyJobs = ["static-typecheck", "unit", "browser", "build", "windows_process"];
const decisions = (code) => Object.fromEntries(lanes.map((lane) => [`CODE_${lane}`, code]));
const runGate = (overrides = {}) =>
  spawnSync("bash", ["-e", "-c", code], {
    encoding: "utf8",
    env: {
      ...process.env,
      STATIC_FAST: "success",
      ...Object.fromEntries(lanes.map((lane) => [lane, "success"])),
      ...decisions("true"),
      ...overrides,
    },
  }).status;

test("full validation and docs-only runs pass the exact aggregate", () => {
  assert.equal(runGate(), 0);
  assert.equal(runGate(decisions("false")), 0);
});
for (const lane of lanes) {
  test(`${lane}: failure, cancellation and skip cannot pass, docs-only or not`, () => {
    for (const status of ["failure", "cancelled", "skipped", ""]) {
      assert.notEqual(runGate({ [lane]: status }), 0);
      assert.notEqual(runGate({ ...decisions("false"), [lane]: status }), 0);
    }
  });
  test(`${lane}: a missing, invalid or disagreeing docs-only decision fails closed`, () => {
    for (const value of ["", "undefined", "TRUE", "false"])
      assert.notEqual(runGate({ [`CODE_${lane}`]: value }), 0);
    assert.notEqual(runGate({ ...decisions("false"), [`CODE_${lane}`]: "true" }), 0);
  });
}
test("static failures fail closed", () => {
  for (const status of ["failure", "cancelled", "skipped", ""])
    assert.notEqual(runGate({ STATIC_FAST: status }), 0);
});
test("no lane waits on another; each detects docs-only changes before any work", () => {
  assert.equal(jobs.changes, undefined);
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "quality") continue;
    assert.equal(job.needs, undefined, name);
    assert.equal(job.if, undefined, name);
  }
  assert.deepEqual(jobs.quality.needs, ["static-fast", ...heavyJobs]);
  const condition = "steps.changes.outputs.code == 'true'";
  for (const name of heavyJobs) {
    const { steps, outputs } = jobs[name];
    assert.deepEqual(outputs, { code: "${{ steps.changes.outputs.code }}" }, name);
    assert.ok(steps[0].uses.startsWith("actions/checkout@"), name);
    assert.equal(steps[0].if, undefined, name);
    assert.equal(steps[1].name, "Start job clock", name);
    assert.equal(steps[2].id, "changes", name);
    assert.equal(steps[2].run, "node .github/scripts/detect-code-changes.mjs", name);
    assert.equal(steps[2].if, undefined, name);
    // Every later step, including each member of a parallel group, is skipped
    // only by this lane's own decision. A wait step takes no condition: it
    // joins a background step that carries one.
    const later = steps.slice(3, -1).flatMap((step) => step.parallel ?? [step]);
    for (const step of later) {
      if (step.wait) {
        assert.equal(step.if, undefined, `${name}: ${step.name}`);
        assert.ok(String(steps.find((other) => other.id === step.wait)?.if).startsWith(condition));
        continue;
      }
      assert.ok(
        String(step.if).replaceAll(/\s+/g, " ").startsWith(condition),
        `${name}: ${step.name}`,
      );
    }
    const lane = lanes[heavyJobs.indexOf(name)];
    assert.equal(jobs.quality.steps[0].env[`CODE_${lane}`], `\${{ needs.${name}.outputs.code }}`);
  }
});
test("every job starts a clock after checkout and ends by enforcing a budget inside its timeout", () => {
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "quality") continue;
    const { steps } = job;
    // Checkout comes first; the clock starts right after it.
    assert.ok(steps[0].uses.startsWith("actions/checkout@"), name);
    assert.deepEqual(
      steps[1],
      {
        name: "Start job clock",
        shell: "bash",
        run: 'echo "CI_JOB_STARTED=$(date +%s)" >> "$GITHUB_ENV"',
      },
      name,
    );
    const last = steps.at(-1);
    assert.equal(last.name, "Enforce job budget", name);
    assert.equal(last.run, "node .github/scripts/job-budget.mjs", name);
    // Only a job that passed everything else is judged on time, and nothing may excuse it.
    assert.equal(last.if, undefined, name);
    assert.equal(last["continue-on-error"], undefined, name);
    const budget = last.env.CI_JOB_BUDGET_SECONDS;
    const budgets =
      budget === "${{ matrix.budget }}"
        ? job.strategy.matrix.include.map((lane) => lane.budget)
        : [Number(budget)];
    for (const seconds of budgets)
      assert.ok(Number.isInteger(seconds) && seconds > 0, `${name}: ${seconds}`);
    // The timeout only catches a hang: the budget step must be reachable first,
    // and the timeout must not drift far above the slowest lane's budget.
    const slowest = Math.max(...budgets);
    assert.ok(job["timeout-minutes"] * 60 >= slowest + 60, name);
    assert.ok(job["timeout-minutes"] * 60 <= slowest + 240, name);
  }
});
test("a budget fails when exceeded or unreadable and reports a cold dependency cache", () => {
  const check = (overrides) =>
    checkBudget({ started: 1000, budget: 60, now: 1050, coldCache: "", ...overrides });
  assert.deepEqual(check({}), {
    ok: true,
    elapsed: 50,
    message: "Within budget: 50 s of a 60 s budget.",
  });
  assert.equal(check({ now: 1060 }).ok, true);
  assert.equal(check({ now: 1061 }).ok, false);
  assert.match(check({ now: 1061 }).message, /Over budget: 61 s of a 60 s budget/);
  const cold = check({ now: 1100, coldCache: "node_modules" });
  assert.equal(cold.ok, true);
  assert.match(cold.message, /cold node_modules cache, not enforced/);
  for (const broken of [
    { started: Number.NaN },
    { started: 0 },
    { budget: Number.NaN },
    { budget: 0 },
  ])
    assert.equal(check(broken).ok, false);
  const coldStep = requireFromScripts("yaml")
    .parse(setup)
    .runs.steps.find((step) => step.name === "Mark cold dependency cache");
  assert.equal(
    coldStep.if,
    "${{ steps.modules.outcome == 'success' && steps.modules.outputs.cache-hit != 'true' }}",
  );
});
test("docs-only detection keeps code in docs-like trees on the code path", () => {
  for (const path of [
    "README.md",
    "docs/release.md",
    "docs/img/a.png",
    "apps/web/notes.mdx",
    "apps/marketing/content/post.json",
    ".github/evidence/shot.png",
  ])
    assert.ok(isDocsPath(path), path);
  for (const path of [
    "apps/marketing/src/docs/page.tsx",
    "apps/web/src/assets/icons.ts",
    "apps/web/public/icon.png",
    ".github/workflows/ci.yml",
    "README.md.ts",
    "package.json",
  ])
    assert.ok(!isDocsPath(path), path);
  assert.equal(hasCodeChanges(["README.md", "docs/a.md"]), false);
  assert.equal(hasCodeChanges(["README.md", "apps/web/src/a.ts"]), true);
  assert.equal(hasCodeChanges([]), true);
});
test("change lists that are unavailable or may be truncated run every lane", async () => {
  const pull = { eventName: "pull_request", event: { pull_request: { number: 7 } } };
  const page = (count, filename) => Array.from({ length: count }, () => ({ filename }));
  assert.deepEqual(
    await changedPaths({
      ...pull,
      request: async (_api, path) =>
        path.endsWith("page=1")
          ? page(100, "a.md")
          : [{ filename: "b.md", previous_filename: "b.ts" }],
    }),
    [...page(100, "a.md").map((file) => file.filename), "b.md", "b.ts"],
  );
  assert.equal(await changedPaths({ ...pull, request: async () => page(100, "a.md") }), null);
  const push = (event, files) =>
    changedPaths({ eventName: "push", event, request: async () => ({ files }) });
  assert.deepEqual(await push({ before: "abc", after: "def" }, page(1, "a.md")), ["a.md"]);
  assert.equal(await push({ before: "abc", after: "def" }, page(300, "a.md")), null);
  assert.equal(await push({ before: "0000000", after: "def" }, page(1, "a.md")), null);
  assert.equal(await push({ before: "abc", after: "def", forced: true }, page(1, "a.md")), null);
  for (const eventName of ["merge_group", "workflow_dispatch", "schedule"])
    assert.equal(await changedPaths({ eventName, event: {}, request: async () => [] }), null);
});
test("required check and independent static lane stay intact", () => {
  assert.ok(workflow.includes("name: Format, Lint, Typecheck, Test, Browser Test, Build"));
  const staticJob = workflow.split("  static-fast:\n")[1].split("  static-typecheck:\n")[0];
  assert.ok(!staticJob.includes("needs:"));
  assert.ok(staticJob.includes("node scripts/release-smoke.ts"));
  assert.ok(!workflow.includes("  release_smoke:"));
  assert.ok(!workflow.includes("continue-on-error"));
});
test("the required Typecheck lane also fails on missing release tags or broken migration lineage", () => {
  const typecheck = jobs["static-typecheck"];
  const gate = jobs.quality;
  const checks = typecheck.steps.find((step) => step.parallel)?.parallel;
  assert.ok(checks);
  assert.ok(gate.needs.includes("static-typecheck"));
  assert.equal(gate.steps[0].env.TYPECHECK, "${{ needs.static-typecheck.result }}");
  assert.ok(!jobs.migration_lineage);
  const lineage = checks.find((step) => step.name === "Verify released migration lineage");
  assert.ok(lineage);
  // Skipped only by the lane's own docs-only decision, never by another condition.
  assert.equal(lineage.if, "steps.changes.outputs.code == 'true'");
  assert.ok(lineage.run.includes("git tag --list 'v[0-9]*'"));
  assert.ok(lineage.run.includes("node scripts/check-migration-lineage.ts"));
  const run = (gitBody, nodeBody) =>
    spawnSync(
      "bash",
      ["-e", "-c", `git() { ${gitBody}; }\nnode() { ${nodeBody}; }\n${lineage.run}`],
      { encoding: "utf8" },
    );
  const missing = run("return 0", "echo unexpected; return 0");
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Release tags are missing/);
  assert.doesNotMatch(missing.stdout, /unexpected/);
  assert.equal(run("echo v1.0.0", "return 1").status, 1);
  assert.equal(run("echo v1.0.0", "return 0").status, 0);
});
test("history readers clone blobless; jobs that never read history stay shallow", () => {
  const historyReaders = [];
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"))) {
      if (step.with?.["fetch-depth"] !== 0) continue;
      historyReaders.push(name);
      assert.equal(step.with.filter, "blob:none", name);
    }
  }
  assert.deepEqual(historyReaders, ["static-typecheck"]);
});
test("filtered scopes preserve lifecycle scripts and the scripts workspace links", () => {
  assert.ok(
    setup.includes(
      "static) bun install --frozen-lockfile --filter './' --filter '@synara/scripts'",
    ),
  );
  assert.ok(setup.includes("runtime) bun install --frozen-lockfile --filter '!@synara/marketing'"));
  assert.ok(!setup.includes("--ignore-scripts"));
  assert.ok(setup.includes("inputs.turbo == 'true'"));
  const turbo = JSON.parse(read("../../turbo.json"));
  assert.equal(turbo.tasks.test.cache, false);
  assert.equal(turbo.tasks.typecheck.cache, false);
});
test("the web build skips dependency builds but still hashes dependency sources", () => {
  const turbo = JSON.parse(read("../../turbo.json"));
  assert.deepEqual(turbo.tasks.build.dependsOn, ["^build"]);
  // No package defines a `transit` script: the task only propagates hashes.
  assert.deepEqual(turbo.tasks.transit, { dependsOn: ["^transit"] });
  const web = read("../../apps/web/turbo.jsonc");
  assert.ok(web.includes('"dependsOn": ["^transit"]'));
  for (const workspace of ["apps/web", "packages/contracts", "packages/shared"])
    assert.equal(
      JSON.parse(read(`../../${workspace}/package.json`)).scripts.transit,
      undefined,
      workspace,
    );
  // Dropping the build edge is only sound while web resolves contracts from source.
  const contracts = JSON.parse(read("../../packages/contracts/package.json"));
  assert.equal(contracts.exports["."].import, "./src/index.ts");
});
test("caches restore in every consumer and save from one owner per key", () => {
  const steps = Object.fromEntries(
    setup
      .split("\n    - name: ")
      .slice(1)
      .map((step) => [step.split("\n")[0], step]),
  );
  const modulesKey =
    "${{ runner.os }}-${{ runner.arch }}-bun-modules-v3-electron-false-${{ inputs.scope != 'full' && format('{0}-', inputs.scope) || '' }}${{ steps.modules-key.outputs.fingerprint }}";
  const modulesConsumers =
    "runner.os != 'Windows' && (inputs.scope == 'full' || inputs.scope == 'web' || inputs.scope == 'server')";
  // The Bun package archive shared the modules hash, so it missed whenever it was needed.
  assert.ok(!setup.includes("~/.bun/install/cache"));
  const fingerprint = steps["Fingerprint dependency inputs"];
  assert.ok(fingerprint.includes("id: modules-key"));
  assert.ok(fingerprint.includes(`if: \${{ ${modulesConsumers} }}`));
  assert.ok(fingerprint.includes("node scripts/ci-install-key.ts"));
  assert.ok(
    steps["Install dependencies"].includes(
      "server) bun install --frozen-lockfile --filter './' --filter '@synara/cli' --filter '@synara/desktop' --filter '@synara/analytics' --concurrent-scripts=1",
    ),
  );
  const restore = steps["Restore node_modules"];
  assert.ok(restore.includes("uses: actions/cache/restore@v5"));
  assert.ok(restore.includes(`if: \${{ ${modulesConsumers} }}`));
  assert.ok(restore.includes(`key: ${modulesKey}`));
  assert.ok(!restore.includes("restore-keys"), "modules restore stays exact-key only");
  const save = steps["Save node_modules"];
  assert.ok(save.includes("uses: actions/cache/save@v5"));
  for (const condition of [
    modulesConsumers,
    "inputs.save-modules == 'true'",
    "steps.modules.outputs.cache-hit != 'true'",
  ])
    assert.ok(save.includes(condition), condition);
  assert.ok(save.includes("key: ${{ steps.modules.outputs.cache-primary-key }}"));
  assert.equal(setup.match(/actions\/cache\/save@/g)?.length, 1);
  assert.ok(steps["Install dependencies"].includes('ELECTRON_SKIP_BINARY_DOWNLOAD: "1"'));
  assert.ok(
    setup.indexOf("- name: Save node_modules") <
      setup.indexOf("- name: Install Electron test runtime"),
    "shared dependency archives must exclude the extracted Electron runtime",
  );
  const actionDefault = setup.split("  save-modules:\n")[1].split("\n\n")[0];
  assert.ok(actionDefault.includes('default: "false"'), "restore-only unless a job opts in");
  // Typecheck owns the full key. The Web and Server matrix
  // entries below each nominate one owner for their own key.
  const savers = Object.entries(jobs)
    .filter(([, job]) => job.steps.some((step) => step.with?.["save-modules"] === "true"))
    .map(([name]) => name);
  assert.deepEqual(savers, ["static-typecheck"]);
  const desktopSetup = jobs.build.steps.find(
    (step) => step.uses === "./.github/actions/setup-workspace",
  );
  assert.equal(desktopSetup.with.scope, "server");
  assert.equal(desktopSetup.with.electron, "true");
  assert.equal(desktopSetup.with["save-modules"], undefined);
  const unitSetup = jobs.unit.steps.find(
    (step) => step.uses === "./.github/actions/setup-workspace",
  );
  assert.deepEqual(unitSetup.with, {
    scope: "${{ matrix.scope || 'full' }}",
    "save-modules": "${{ matrix.save-modules || 'false' }}",
    "web-transform-cache": "${{ matrix.web-transform-cache || '' }}",
  });
  assert.deepEqual(
    jobs.unit.strategy.matrix.include.filter((lane) => lane.scope || lane["save-modules"]),
    [
      {
        pkg: "web",
        filters: "--filter=@synara/web",
        "test-args": "--config=vitest.unit.ci.config.ts --project=web --project=web-local-time",
        scope: "web",
        "save-modules": "true",
        budget: 240,
      },
      {
        pkg: "server 1/3",
        filters: "--filter=@synara/cli",
        "test-args": "--shard=1/3",
        scope: "server",
        "save-modules": "true",
        budget: 210,
      },
      {
        pkg: "server 2/3",
        filters: "--filter=@synara/cli",
        "test-args": "--shard=2/3",
        scope: "server",
        budget: 210,
      },
      {
        pkg: "server 3/3",
        filters: "--filter=@synara/cli",
        "test-args": "--shard=3/3",
        scope: "server",
        budget: 210,
      },
    ],
  );
  const browserSetup = jobs.browser.steps.find(
    (step) => step.uses === "./.github/actions/setup-workspace",
  );
  assert.equal(browserSetup.with.scope, "web");
  assert.equal(browserSetup.with["save-modules"], undefined);
  // Turbo: pull requests restore main's newest entry; only pushes to main save.
  const main = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  assert.ok(steps["Restore Turbo outputs"].includes("uses: actions/cache/restore@v5"));
  assert.ok(steps["Restore Turbo outputs"].includes(`inputs.turbo == 'true' && !(${main})`));
  assert.ok(steps["Cache Turbo outputs (main)"].includes("uses: actions/cache@v5"));
  assert.ok(steps["Cache Turbo outputs (main)"].includes(`inputs.turbo == 'true' && ${main}`));
  const saving = Object.entries(steps)
    .filter(([, step]) => step.includes("uses: actions/cache@"))
    .map(([name]) => name);
  assert.deepEqual(saving, [
    "Cache Turbo outputs (main)",
    "Cache web transform results (main or first branch run)",
    "Cache Electron runtime",
  ]);
});
test("compiler cache tracks compiler inputs and survives workspace bumps and bundler-only edits", () => {
  const scratch = mkdtempSync(join(tmpdir(), "synara-compiler-key-"));
  try {
    mkdirSync(join(scratch, "apps/web"), { recursive: true });
    mkdirSync(join(scratch, "scripts"));
    for (const file of [
      "package.json",
      "apps/web/vite.config.ts",
      "apps/web/scripts",
      "scripts/bun-lockfile.ts",
      "patches",
    ]) {
      cpSync(new URL(`../../${file}`, import.meta.url), join(scratch, file), { recursive: true });
    }
    const lockfile = `{
      "lockfileVersion": 3,
      "workspaces": {
        "apps/web": {
          "name": "@synara/web",
          "version": "1.5.4",
          "dependencies": { "version": "^2.0.0", },
        },
      },
      "packages": { "version": ["version@2.0.0", "fixture,]", {}, "sha512-fixture",], },
    }`;
    const fingerprint = (contents) => {
      writeFileSync(join(scratch, "bun.lock"), contents);
      return compilerCacheFingerprint(scratch);
    };
    const baseline = fingerprint(lockfile);
    assert.equal(fingerprint(lockfile.replace("1.5.4", "1.6.2")), baseline);
    const bundler = join(scratch, "apps/web/vite.config.ts");
    const bundlerSource = readFileSync(bundler, "utf8");
    writeFileSync(
      bundler,
      bundlerSource.replace("autoCodeSplitting: true", "autoCodeSplitting: false"),
    );
    assert.notEqual(readFileSync(bundler, "utf8"), bundlerSource);
    assert.equal(fingerprint(lockfile), baseline);
    const compiler = join(scratch, "apps/web/scripts/react-compiler-vite.ts");
    const compilerSource = readFileSync(compiler, "utf8");
    writeFileSync(compiler, compilerSource.replace("!productionBuild &&", "productionBuild &&"));
    assert.notEqual(readFileSync(compiler, "utf8"), compilerSource);
    assert.notEqual(fingerprint(lockfile), baseline);
    writeFileSync(compiler, compilerSource);
    assert.notEqual(fingerprint(lockfile.replace("^2.0.0", "^2.1.0")), baseline);
    assert.notEqual(fingerprint(lockfile.replace("version@2.0.0", "version@2.1.0")), baseline);
    assert.notEqual(fingerprint(lockfile.replace("fixture,]", "fixture]")), baseline);
    const unknown = lockfile.replace('"lockfileVersion": 3', '"lockfileVersion": 4');
    assert.notEqual(fingerprint(unknown), fingerprint(unknown.replace("1.5.4", "1.6.2")));
    writeFileSync(join(scratch, "patches/compiler.patch"), "fixture patch");
    assert.notEqual(fingerprint(lockfile), baseline);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("dependency archives survive release metadata bumps and invalidate install inputs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "synara-install-key-"));
  try {
    const inputs = {
      "package.json": JSON.stringify({
        packageManager: "bun@1.4.4",
        workspaces: { packages: ["apps/*"] },
        patchedDependencies: { "dep@2.0.0": "patches/dep.patch" },
      }),
      "bun.lock": `{
        "lockfileVersion": 3,
        "workspaces": { "apps/web": { "version": "1.5.4", }, },
        "packages": { "dep": ["dep@2.0.0", "", {}, "sha512-example",], },
      }`,
      "apps/web/package.json": JSON.stringify({
        name: "@synara/web",
        version: "1.5.4",
        scripts: { prepare: "node prepare.mjs" },
      }),
      "bunfig.toml": '[install]\nlinker = "isolated"\n',
      "scripts/patch-workspace-typescript.ts": "// root install hook\n",
      "patches/dep.patch": "original patch",
    };
    for (const directory of ["apps/web", "scripts", "patches"])
      mkdirSync(join(scratch, directory), { recursive: true });
    const write = (file, text) => writeFileSync(join(scratch, file), text);
    for (const [file, input] of Object.entries(inputs)) write(file, input);
    const fingerprint = () => workspaceInstallFingerprint(scratch);
    const seed = fingerprint();
    for (const file of ["bun.lock", "apps/web/package.json"]) {
      write(file, inputs[file].replace("1.5.4", "1.6.2"));
      assert.equal(fingerprint(), seed, file);
    }
    for (const [file, before, after] of [
      ["package.json", "bun@1.4.4", "bun@1.4.5"],
      ["apps/web/package.json", "prepare.mjs", "other.mjs"],
      ["bun.lock", "sha512-example", "sha512-changed"],
      ["bunfig.toml", "isolated", "hoisted"],
      ["scripts/patch-workspace-typescript.ts", "root install hook", "updated hook"],
      ["patches/dep.patch", "original patch", "updated patch"],
    ]) {
      write(file, inputs[file].replace(before, after));
      assert.notEqual(fingerprint(), seed, file);
      write(file, inputs[file]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("browser tests and Desktop CI use separate compiler cache namespaces", () => {
  assert.match(workflowEnv.SYNARA_CI_NODE_VERSION, /^\d+\.\d+\.\d+$/);
  const setupSteps = requireFromScripts("yaml").parse(setup).runs.steps;
  const nodeIndex = setupSteps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.deepEqual(setupSteps[nodeIndex]?.with, {
    "node-version": "${{ env.SYNARA_CI_NODE_VERSION }}",
    "node-version-file": "${{ env.SYNARA_CI_NODE_VERSION == '' && 'package.json' || '' }}",
  });
  assert.ok(nodeIndex < setupSteps.findIndex((step) => step.id === "web-transform-key"));
  const steps = Object.fromEntries(
    setup
      .split("\n    - name: ")
      .slice(1)
      .map((step) => [step.split("\n")[0], step]),
  );
  const main = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  const prefix =
    "${{ runner.os }}-${{ runner.arch }}-web-transform-v2-${{ inputs.web-transform-cache }}-${{ steps.web-transform-key.outputs.fingerprint }}-";
  const fingerprint = steps["Fingerprint web compiler inputs"];
  assert.ok(fingerprint.includes("id: web-transform-key"));
  assert.ok(fingerprint.includes("if: inputs.web-transform-cache != ''"));
  assert.ok(fingerprint.includes("node apps/web/scripts/compiler-cache-key.ts"));
  assert.ok(setup.indexOf(fingerprint) < setup.indexOf(steps["Restore web transform cache"]));
  const restore = steps["Restore web transform cache"];
  const save = steps["Cache web transform results (main or first branch run)"];
  assert.ok(restore.includes("uses: actions/cache/restore@v5"));
  assert.ok(restore.includes(`inputs.web-transform-cache != '' && !(${main})`));
  assert.ok(setup.indexOf(restore) < setup.indexOf(save));
  // A branch saves only when no archive matched; main saves one entry per commit.
  assert.ok(
    save.includes(
      `inputs.web-transform-cache != '' && ((${main}) || steps.web-transform.outputs.cache-matched-key == '')`,
    ),
  );
  for (const step of [restore, save]) {
    assert.ok(step.includes(`key: ${prefix}\${{ github.sha }}`));
    assert.ok(step.includes(`restore-keys: |\n          ${prefix}\n`));
    assert.ok(step.includes("path: ${{ runner.temp }}/web-transform-cache"));
  }
  const fallback =
    "${{ inputs.web-transform-fallback != '' && format('{0}-{1}-web-transform-v2-{2}-{3}-', runner.os, runner.arch, inputs.web-transform-fallback, steps.web-transform-key.outputs.fingerprint) || '' }}";
  assert.ok(save.includes(`restore-keys: |\n          ${prefix}\n          ${fallback}\n`));
  assert.ok(!restore.includes(fallback));
  // The Vite salt and the archive key begin with the same input fingerprint.
  const viteConfig = read("../../apps/web/vite.config.ts");
  assert.ok(viteConfig.includes("createViteReactCompilerPlugin(buildSourcemap)"));
  const compilerAdapter = read("../../apps/web/scripts/react-compiler-vite.ts");
  assert.ok(compilerAdapter.includes(".update(compilerCacheFingerprint("));
  // Workers must compile with the plugin definition the main thread uses.
  const worker = read("../../apps/web/scripts/parallel-transform.worker.mjs");
  assert.ok(worker.includes('from "./react-compiler-plugin.mjs"'));
  assert.ok(compilerAdapter.includes('from "./react-compiler-plugin.mjs"'));
  assert.ok(!viteConfig.includes("reactCompilerPreset"), "one definition of the compiler plugin");
  const pool = read("../../apps/web/scripts/parallel-transform.ts");
  for (const relaxed of ["retry", "setTimeout"])
    assert.ok(!pool.includes(relaxed), `the transform pool must not ${relaxed}`);
  assert.ok(compilerAdapter.includes('command === "build" && mode === "production"'));
  assert.ok(compilerAdapter.includes('process.env.VITEST === "true"'));
  assert.ok(compilerAdapter.includes("transformCacheSalt(productionBuild, buildSourcemap)"));
  // Browser lanes, Desktop Build, and the Core unit lane's matrix entry and setup.
  assert.equal(workflow.match(/web-transform-cache:/g)?.length, 4);
  assert.equal(workflow.match(/web-transform-fallback:/g)?.length, 1);
  const browserSetup = jobs.browser.steps.find((step) => step.name === "Setup workspace").with;
  assert.equal(
    browserSetup["web-transform-cache"],
    "browser-${{ matrix.cache }}-${{ strategy.job-index }}",
  );
  assert.equal(
    browserSetup["web-transform-fallback"],
    "${{ github.event_name == 'pull_request' && strategy.job-index != 5 && 'browser-components-5' || '' }}",
  );
  // The donor index must stay a components job; the first three ChatView jobs
  // keep the archive names main already saves.
  const browserLanes = jobs.browser.strategy.matrix.include;
  assert.equal(browserLanes[5].cache, "components");
  assert.deepEqual(
    browserLanes.slice(0, 3).map(({ cache }) => cache),
    ["chat-follow", "chat-projects", "chat-workflows"],
  );
  assert.equal(
    jobs.build.steps.find((step) => step.name === "Setup workspace").with["web-transform-cache"],
    "desktop-production",
  );
  const desktopBuild = jobs.build.steps.find((step) => step.id === "desktop-build");
  assert.equal(
    desktopBuild.env.SYNARA_WEB_BUILD_TRANSFORM_CACHE_DIR,
    "${{ runner.temp }}/web-transform-cache",
  );
  assert.equal(workflow.match(/SYNARA_WEB_BUILD_TRANSFORM_CACHE_DIR:/g)?.length, 1);
  assert.ok(
    read("../../apps/web/turbo.jsonc").includes(
      '"passThroughEnv": ["SYNARA_WEB_BUILD_TRANSFORM_CACHE_DIR"]',
    ),
  );
  for (const other of [
    "../workflows/release.yml",
    "../workflows/release-platform.yml",
    "../workflows/ci-nightly.yml",
  ]) {
    const text = read(other);
    assert.ok(!text.includes("web-transform-cache"), other);
    assert.ok(!text.includes("web-transform-fallback"), other);
    assert.ok(!text.includes("SYNARA_WEB_TRANSFORM_CACHE_DIR"), other);
    assert.ok(!text.includes("SYNARA_WEB_BUILD_TRANSFORM_CACHE_DIR"), other);
  }
});
test("only the Core lane replays hot-path compiler events, keyed by source and toolchain", () => {
  const cached = jobs.unit.strategy.matrix.include.filter((lane) => lane["web-transform-cache"]);
  assert.deepEqual(
    cached.map((lane) => [lane.pkg, lane["web-transform-cache"]]),
    [["core", "unit-core-compiler"]],
  );
  const setupWith = jobs.unit.steps.find((step) => step.name === "Setup workspace").with;
  assert.equal(setupWith["web-transform-fallback"], undefined);
  const compiler = jobs.unit.steps
    .find((step) => step.parallel)
    .parallel.find(({ name }) => name === "Verify chat hot-path compiler");
  // The guard reads the directory the setup action exports; nothing overrides it.
  assert.equal(compiler.env, undefined);
  const cache = read("../../apps/web/src/test/compilerEventCache.ts");
  assert.ok(cache.includes("env.SYNARA_WEB_TRANSFORM_CACHE_DIR?.trim()"));
  assert.ok(cache.includes('path.join(root, "hot-path-compiler")'));
  assert.ok(cache.includes(".update(compilerCacheFingerprint(repositoryRoot))"));
  for (const input of ["toolchain", "path.resolve(input.filePath)", "input.source"])
    assert.ok(cache.includes(`.update(${input})`), input);
  for (const file of ["compilerEventCache.ts", "hotPathCompiler.ts", "reactCompiler.ts"])
    assert.ok(cache.includes(`"src/test/${file}"`), file);
  for (const name of ["babel-plugin-react-compiler", "@babel/core"])
    assert.ok(cache.includes(`"${name}"`), name);
  const guard = read("../../apps/web/src/test/hotPathCompiler.ts");
  assert.ok(guard.includes("cachedCompilerEvents({"));
  assert.ok(guard.includes("compile: () => compileReactSource(filePath, source)"));
});
test("the Electron runtime cache keys on its own lockfile resolution", () => {
  const steps = Object.fromEntries(
    setup
      .split("\n    - name: ")
      .slice(1)
      .map((step) => [step.split("\n")[0], step]),
  );
  const electronKey = steps["Fingerprint Electron runtime"];
  assert.ok(electronKey.includes("id: electron-key"));
  assert.ok(electronKey.includes("if: ${{ inputs.electron == 'true' }}"));
  assert.ok(
    electronKey.includes('fingerprint="$(node .github/scripts/lockfile-package-key.mjs electron)"'),
  );
  assert.ok(setup.indexOf(electronKey) < setup.indexOf(steps["Cache Electron runtime"]));
  assert.ok(
    steps["Cache Electron runtime"].includes(
      "key: ${{ runner.os }}-${{ runner.arch }}-electron-v2-${{ steps.electron-key.outputs.fingerprint }}",
    ),
  );

  const lockfile = `{
    "lockfileVersion": 1,
    "workspaces": {
      "apps/web": { "name": "@synara/web", "version": "1.5.4" },
    },
    "packages": {
      "@axe-core/playwright": ["@axe-core/playwright@4.13.0", "", {}, "sha512-axe"],
      "@electron/get": ["@electron/get@5.0.0", "", {}, "sha512-get"],
      "betterwright/playwright-core": ["playwright-core@1.61.1", "", {}, "sha512-nested"],
      "electron": ["electron@43.8.7", "", {}, "sha512-electron"],
      "playwright": ["playwright@1.62.1", "", {}, "sha512-playwright"],
      "playwright-core": ["playwright-core@1.62.1", "", {}, "sha512-core"],
    },
  }`;
  const playwright = (contents) =>
    lockfilePackageFingerprint(contents, ["playwright", "playwright-core"]);
  const electron = (contents) => lockfilePackageFingerprint(contents, ["electron"]);
  assert.equal(playwright(lockfile.replace("1.5.4", "1.6.2")), playwright(lockfile));
  assert.equal(electron(lockfile.replace("1.5.4", "1.6.2")), electron(lockfile));
  assert.equal(playwright(lockfile.replace("sha512-axe", "sha512-other")), playwright(lockfile));
  assert.equal(electron(lockfile.replace("sha512-get", "sha512-other")), electron(lockfile));
  assert.notEqual(playwright(lockfile.replace("core@1.62.1", "core@1.63.0")), playwright(lockfile));
  assert.notEqual(playwright(lockfile.replace("core@1.61.1", "core@1.61.2")), playwright(lockfile));
  assert.notEqual(
    electron(lockfile.replace("electron@43.8.7", "electron@43.9.0")),
    electron(lockfile),
  );
  assert.throws(() => lockfilePackageFingerprint(lockfile, ["missing"]), /no entry for missing/);
});
test("fingerprint steps fail instead of writing an empty cache key", () => {
  const scratch = mkdtempSync(join(tmpdir(), "synara-empty-fingerprint-"));
  try {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const name of [
      "Fingerprint dependency inputs",
      "Fingerprint web compiler inputs",
      "Fingerprint Electron runtime",
    ]) {
      const run = setup.match(
        new RegExp(
          `- name: ${name}[\\s\\S]*?      run: \\|\\n([\\s\\S]*?)(?=\\n\\n|\\n    - name:)`,
        ),
      )?.[1];
      assert.ok(run, name);
      const output = join(scratch, `${name}.out`);
      const result = spawnSync("bash", ["-e", "-c", run.replace(/^        /gm, "")], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output },
      });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stdout, /::error::The .* fingerprint is empty\./, name);
      assert.throws(() => readFileSync(output), name);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("a restored compiler cache drops claims and staging files from interrupted processes", () => {
  const enable = setup.match(
    /- name: Enable web transform cache[\s\S]*?      run: \|\n([\s\S]*?)(?=\n\n|\n    - name:)/,
  )?.[1];
  assert.ok(enable, "The actual setup shell must be covered");
  const scratch = mkdtempSync(join(tmpdir(), "synara-transform-claims-"));
  try {
    const cache = join(scratch, "web-transform-cache");
    mkdirSync(join(cache, "ab", "abcd.json.lock"), { recursive: true });
    writeFileSync(join(cache, "ab", "abcd.json"), "{}");
    writeFileSync(join(cache, "ab", "abcd.json.123.1.tmp"), "partial");
    const githubEnv = join(scratch, "github-env");
    const result = spawnSync("bash", ["-e", "-c", enable.replace(/^        /gm, "")], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: scratch, GITHUB_ENV: githubEnv },
    });
    assert.equal(result.status, 0, result.stderr);
    const listing = spawnSync("find", [cache, "-mindepth", "1"], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .toSorted();
    assert.deepEqual(listing, [join(cache, "ab"), join(cache, "ab", "abcd.json")]);
    assert.equal(readFileSync(githubEnv, "utf8"), `SYNARA_WEB_TRANSFORM_CACHE_DIR=${cache}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("Windows uses the runner-volume cache and Web installs only its dependency closure", () => {
  const install = setup.match(
    /- name: Install dependencies[\s\S]*?      run: \|\n([\s\S]*?)(?=\n    - name:)/,
  )?.[1];
  assert.ok(install);
  const command = install
    .split("\n")
    .map((line) => line.replace(/^        /, ""))
    .join("\n");
  for (const [platform, scope, filters] of [
    ["Windows", "runtime", ["!@synara/marketing"]],
    ["Linux", "runtime", ["!@synara/marketing"]],
    ["macOS", "runtime", ["!@synara/marketing"]],
    ["Linux", "web", ["./", "@synara/web"]],
    ["Linux", "server", ["./", "@synara/cli", "@synara/desktop", "@synara/analytics"]],
  ]) {
    const result = spawnSync(
      "bash",
      [
        "-e",
        "-c",
        `bun() { printf 'cache=%s\\n' "$BUN_INSTALL_CACHE_DIR"; printf 'arg=%s\\n' "$@"; }\n${command}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_OS: platform,
          RUNNER_TEMP: "/runner temp",
          WORKSPACE_SCOPE: scope,
          BUN_INSTALL_CACHE_DIR: "/existing-cache",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const expectedCache =
      platform === "Windows" ? "/runner temp/bun-install-cache" : "/existing-cache";
    assert.deepEqual(
      result.stdout.trimEnd().split("\n"),
      [
        ...(platform === "Windows" ? [`Bun install cache: ${expectedCache}`] : []),
        `cache=${expectedCache}`,
        "arg=install",
        "arg=--frozen-lockfile",
        ...filters.flatMap((filter) => ["arg=--filter", `arg=${filter}`]),
        "arg=--concurrent-scripts=1",
      ],
      `${platform}/${scope}`,
    );
  }
});
test("native Windows runtime and recovery tests are not replaced with Linux checks", () => {
  const windows = workflow.split("  windows_process:\n")[1];
  for (const file of [
    "scripts/node-pty-smoke.mjs",
    "src/windowsProcess.test.ts",
    "src/platformProcess.test.ts",
    "src/processRuntime.test.ts",
    "src/filesystemPlatform.test.ts",
    "src/platformEnvironment.test.ts",
    "src/platform/processTreeController.test.ts",
    "src/provider/supervisedProcessTeardown.test.ts",
    "src/provider/providerStartupLifecycle.test.ts",
    "src/processRunner.test.ts",
    "src/providerUsage/providers/droidSecureStorage.test.ts",
    "src/windowsProcessEffect.test.ts",
    "src/backendShutdown.windows.integration.test.ts",
    "src/migrationRecovery.test.ts",
    "src/desktopMigrationRecovery.test.ts",
    "src/persistence/MigrationBackup.test.ts",
    "src/persistence/Migrations/MigrationReplay.test.ts",
  ])
    assert.ok(windows.includes(file), file);
});

test("measured critical-path distribution stays three-way and skips redundant apt provisioning", () => {
  const unitSteps = jobs.unit.steps.find((step) => step.parallel)?.parallel;
  assert.ok(unitSteps);
  assert.ok(unitSteps.some(({ run }) => run.startsWith("bunx turbo run test ")));
  const compiler = unitSteps.find(({ name }) => name === "Verify chat hot-path compiler");
  // Web Unit selects the two other projects. A missing compiler file must
  // therefore fail the Core lane instead of silently passing the required gate.
  assert.equal(compiler?.if, "steps.changes.outputs.code == 'true' && matrix.pkg == 'core'");
  assert.ok(compiler.run.includes("--project=web-compiler --no-passWithNoTests --maxWorkers=2"));
  // ChatView compiles in its own file so both files can run at once.
  const unitConfig = read("../../apps/web/vitest.unit.ci.config.ts");
  for (const file of [
    "src/components/ChatView.compiler.test.ts",
    "src/components/chatHotPath.compiler.test.ts",
  ]) {
    assert.ok(unitConfig.includes(`"${file}"`), file);
    assert.ok(read(`../../apps/web/${file}`).includes("describeHotPathCompilation("), file);
  }
  for (const shard of ["1/3", "2/3", "3/3"])
    assert.ok(workflow.includes(`test-args: "--shard=${shard}"`), `server ${shard}`);
  // Pinned placement only moves whole files between shards; each shard runs
  // its files on every core of its runner.
  const server = JSON.parse(read("../../apps/server/package.json"));
  assert.equal(server.scripts.test, "vitest run");
  const serverConfig = read("../../apps/server/vitest.config.ts");
  assert.ok(serverConfig.includes("maxWorkers: availableParallelism()"));
  assert.ok(serverConfig.includes("sequence: { sequencer: PinnedShardSequencer }"));
  const browserMatrix = jobs.browser.strategy.matrix.include;
  // Nine browser jobs plus the nine other lanes stay inside the account's 20 concurrent jobs.
  assert.equal(browserMatrix.length, 9);
  assert.equal(new Set(browserMatrix.map(({ name }) => name)).size, 9);
  const processes = browserMatrix.flatMap((lane) => [
    { project: lane.projectA, slice: lane.sliceA, shard: lane.shardA },
    { project: lane.projectB, slice: lane.sliceB, shard: lane.shardB },
  ]);
  const owned = (project) => processes.filter((process) => process.project === project);
  // Duplicating a shard or slice would leave its sibling's tests out of a green gate.
  assert.deepEqual(
    owned("components").map(({ shard, slice }) => [shard, slice]),
    Array.from({ length: 10 }, (_, index) => [`${index + 1}/10`, ""]),
  );
  const chatConfig = read("../../apps/web/vitest.browser.ci.config.ts");
  for (const [project, count] of [
    ["chat-follow", 2],
    ["chat-projects", 3],
    ["chat-workflows", 3],
  ]) {
    assert.ok(chatConfig.includes(`"${project}": ${count},`), project);
    assert.deepEqual(
      owned(project)
        .map(({ slice, shard }) => [slice, shard])
        .toSorted(),
      Array.from({ length: count }, (_, index) => [`${index + 1}/${count}`, "1/1"]),
      project,
    );
  }
  assert.equal(processes.length, 18);
  const browserPair = jobs.browser.steps.find((step) => step.parallel)?.parallel;
  assert.deepEqual(
    browserPair?.map((step) => [step.env.VITEST_BROWSER_CHAT_SLICE, step.run]),
    ["A", "B"].map((half) => [
      `\${{ matrix.slice${half} }}`,
      `bun run --cwd apps/web test:browser:ci -- --project=\${{ matrix.project${half} }} --shard=\${{ matrix.shard${half} }}`,
    ]),
  );
  assert.deepEqual(
    browserPair?.map((step) => step.env.SYNARA_WEB_TRANSFORM_CACHE_SHARED),
    ["true", "true"],
  );
  const browserSteps = jobs.browser.steps;
  const checkoutIndex = browserSteps.findIndex((step) => step.name === "Checkout");
  const cacheIndex = browserSteps.findIndex((step) => step.id === "chromium-cache");
  const setupIndex = browserSteps.findIndex((step) => step.name === "Setup workspace");
  const waitIndex = browserSteps.findIndex((step) => step.wait === "chromium-cache");
  const installIndex = browserSteps.findIndex(
    (step) => step.name === "Install browser test runtime",
  );
  const saveIndex = browserSteps.findIndex((step) => step.name === "Save Chromium headless shell");
  const firstTestIndex = browserSteps.findIndex((step) => step.parallel);
  const cache = browserSteps[cacheIndex];
  const runtime = browserSteps[installIndex];
  const save = browserSteps[saveIndex];
  assert.ok(checkoutIndex >= 0 && checkoutIndex < cacheIndex && cacheIndex < setupIndex);
  assert.ok(setupIndex < waitIndex && waitIndex < installIndex);
  assert.ok(installIndex < saveIndex && saveIndex < firstTestIndex);
  assert.equal(cache.uses, "actions/cache/restore@v5");
  assert.equal(cache.background, true);
  assert.equal(save.uses, "actions/cache/save@v5");
  assert.equal(save.with.path, cache.with.path);
  assert.equal(save.with.key, "${{ steps.chromium-cache.outputs.cache-primary-key }}");
  assert.match(save.if, /matrix\.name == 'chat-follow'/);
  assert.match(save.if, /steps\.chromium-cache\.outputs\.cache-hit != 'true'/);
  assert.match(save.if, /steps\.chromium-cache\.outputs\.cache-primary-key != ''/);
  assert.ok(runtime.run.includes("./node_modules/.bin/playwright install chromium --only-shell"));
  assert.ok(!runtime.run.includes("--with-deps"));
  assert.ok(runtime.run.includes('PLAYWRIGHT_BROWSERS_PATH="$RUNNER_TEMP/playwright-headless"'));
  assert.ok(runtime.run.includes('>> "$GITHUB_ENV"'));
  assert.equal(cache.with.path, "${{ runner.temp }}/playwright-headless");
  assert.ok(cache.with.key.includes("-playwright-chromium-shell-"));
});

test("only the Electron lifecycle smoke overlaps the desktop build", () => {
  const steps = jobs.build.steps;
  const sandbox = steps.findIndex((step) => step.run?.includes("chrome-sandbox"));
  const build = steps.findIndex((step) => step.run === "bun run build:desktop");
  const lifecycle = steps.findIndex((step) => step.run?.includes("smoke:browser-lifecycle"));
  const focus = steps.findIndex((step) =>
    step.run?.includes("preserves composer keyboard ownership"),
  );
  const preload = steps.findIndex((step) => step.run?.includes("dist-electron/preload.js"));

  const buildStep = steps[build];
  assert.ok(buildStep?.id && buildStep.background === true);
  const wait = steps.findIndex((step) => step.wait === buildStep.id);
  assert.ok(sandbox >= 0 && sandbox < build && build < lifecycle && lifecycle < wait);
  assert.ok(wait < focus && wait < preload);
  assert.ok(!steps[lifecycle].background && !steps[focus].background);
});
