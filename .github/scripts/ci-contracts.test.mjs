import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = read("../workflows/ci.yml");
const requireFromScripts = createRequire(new URL("../../scripts/package.json", import.meta.url));
const { jobs } = requireFromScripts("yaml").parse(workflow);
const setup = read("../actions/setup-workspace/action.yml");
const gate = workflow.match(
  /- name: Aggregate lane results[\s\S]*?        run: \|\n([\s\S]*?)(?=\n  [a-z_]+:|$)/,
)?.[1];
assert.ok(gate, "The actual aggregate shell must be covered, not a separate approximation");
const code = gate
  .split("\n")
  .map((line) => line.replace(/^          /, ""))
  .join("\n");
const lanes = ["TYPECHECK", "UNIT", "BROWSER", "BUILD", "WINDOWS_PROCESS", "MIGRATION_LINEAGE"];
const runGate = (overrides = {}) =>
  spawnSync("bash", ["-e", "-c", code], {
    encoding: "utf8",
    env: {
      ...process.env,
      CHANGES: "success",
      CODE: "true",
      STATIC_FAST: "success",
      ...Object.fromEntries(lanes.map((lane) => [lane, "success"])),
      ...overrides,
    },
  }).status;

test("full validation and deliberate docs-only skips pass the exact aggregate", () => {
  assert.equal(runGate(), 0);
  assert.equal(
    runGate({ CODE: "false", ...Object.fromEntries(lanes.map((lane) => [lane, "skipped"])) }),
    0,
  );
});
for (const lane of lanes) {
  test(`${lane}: failure, cancellation and unexpected skip cannot pass`, () => {
    for (const status of ["failure", "cancelled", "skipped", ""])
      assert.notEqual(runGate({ [lane]: status }), 0);
  });
}
test("planning failures, invalid output and static failures fail closed", () => {
  for (const status of ["failure", "cancelled", "skipped", ""]) {
    assert.notEqual(runGate({ CHANGES: status }), 0);
    assert.notEqual(runGate({ STATIC_FAST: status }), 0);
  }
  for (const value of ["", "undefined", "TRUE"]) assert.notEqual(runGate({ CODE: value }), 0);
});
test("PR change detection uses inline rules and retains Git checkout for pushes", () => {
  const { steps, permissions } = jobs.changes;
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  const filter = steps.find((step) => step.id === "filter");
  assert.equal(checkout?.if, "github.event_name != 'pull_request'");
  assert.equal(permissions["pull-requests"], "read");
  assert.equal(filter?.if, undefined);
  const rules = filter?.with?.filters;
  assert.equal(typeof rules, "string");
  assert.ok(Array.isArray(requireFromScripts("yaml").parse(rules)?.code));
});
test("docs-only cannot hide a failing or unexpectedly executed heavy lane", () => {
  const docs = { CODE: "false", ...Object.fromEntries(lanes.map((lane) => [lane, "skipped"])) };
  for (const lane of lanes)
    for (const status of ["success", "failure", "cancelled", ""])
      assert.notEqual(runGate({ ...docs, [lane]: status }), 0);
});
test("required check, independent static lane and full-history lineage stay intact", () => {
  assert.ok(workflow.includes("name: Format, Lint, Typecheck, Test, Browser Test, Build"));
  const staticJob = workflow.split("  static-fast:\n")[1].split("  static-typecheck:\n")[0];
  assert.ok(!staticJob.includes("needs:"));
  assert.ok(staticJob.includes("node scripts/release-smoke.ts"));
  assert.ok(!workflow.includes("  release_smoke:"));
  assert.ok(workflow.includes("fetch-depth: 0"));
  assert.ok(workflow.includes("git tag --list 'v[0-9]*'"));
  assert.ok(!workflow.includes("continue-on-error"));
});
test("history readers clone blobless; jobs that never read history stay shallow", () => {
  // Measured: a blobless full clone took 9-12 s per hosted job against 6 s
  // shallow, and 10 s against 37 s for the full clone Migration Lineage used.
  const jobs = workflow.split(/\n(?=  [a-z_-]+:\n)/);
  const historyReaders = ["migration_lineage"];
  let checked = 0;
  for (const job of jobs) {
    const name = job.trimStart().split(":")[0];
    for (const rest of job.split("uses: actions/checkout@v6").slice(1)) {
      const options = rest.split("\n      - ")[0];
      checked++;
      if (historyReaders.includes(name)) {
        assert.ok(options.includes("fetch-depth: 0"), name);
        assert.ok(options.includes("filter: blob:none"), name);
      } else {
        assert.ok(!options.includes("fetch-depth: 0"), `${name} needs no history`);
      }
    }
  }
  assert.ok(checked >= 8);
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
    "${{ runner.os }}-${{ runner.arch }}-bun-modules-v2-electron-${{ inputs.electron }}-${{ inputs.scope == 'web' && 'web-' || '' }}${{ hashFiles('bun.lock', 'package.json') }}";
  const modulesConsumers =
    "runner.os != 'Windows' && (inputs.scope == 'full' || inputs.scope == 'web')";
  // The Bun package archive shared the modules hash, so it missed whenever it was needed.
  assert.ok(!setup.includes("~/.bun/install/cache"));
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
  const actionDefault = setup.split("  save-modules:\n")[1].split("\n\n")[0];
  assert.ok(actionDefault.includes('default: "false"'), "restore-only unless a job opts in");
  // Typecheck and Desktop Build own the two full keys. Web Unit owns the web key.
  const savers = Object.entries(jobs)
    .filter(([, job]) => job.steps.some((step) => step.with?.["save-modules"] === "true"))
    .map(([name]) => name);
  assert.deepEqual(savers, ["static-typecheck", "build"]);
  const unitSetup = jobs.unit.steps.find(
    (step) => step.uses === "./.github/actions/setup-workspace",
  );
  assert.deepEqual(unitSetup.with, {
    scope: "${{ matrix.scope || 'full' }}",
    "save-modules": "${{ matrix.save-modules || 'false' }}",
  });
  assert.deepEqual(
    jobs.unit.strategy.matrix.include.filter((lane) => lane.scope || lane["save-modules"]),
    [
      {
        pkg: "web",
        filters: "--filter=@synara/web",
        "test-args": "--config=vitest.unit.ci.config.ts",
        scope: "web",
        "save-modules": "true",
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
test("web transform cache stays keyed by its inputs and out of production builds", () => {
  const steps = Object.fromEntries(
    setup
      .split("\n    - name: ")
      .slice(1)
      .map((step) => [step.split("\n")[0], step]),
  );
  const main = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  const prefix =
    "${{ runner.os }}-${{ runner.arch }}-web-transform-v1-${{ inputs.web-transform-cache }}-${{ hashFiles('bun.lock', 'apps/web/vite.config.ts', 'apps/web/scripts/react-compiler-plugin.mjs', 'apps/web/scripts/transform-cache.ts') }}-";
  const restore = steps["Restore web transform cache"];
  const save = steps["Cache web transform results (main or first branch run)"];
  assert.ok(restore.includes("uses: actions/cache/restore@v5"));
  assert.ok(restore.includes(`inputs.web-transform-cache != '' && !(${main})`));
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
  // The salt in vite.config.ts must cover every file the archive key hashes.
  const viteConfig = read("../../apps/web/vite.config.ts");
  for (const file of [
    "../../bun.lock",
    "vite.config.ts",
    "scripts/react-compiler-plugin.mjs",
    "scripts/transform-cache.ts",
  ])
    assert.ok(viteConfig.includes(`"${file}"`), file);
  // Workers must compile with the plugin definition the main thread uses, and
  // the pool must stay out of the cache key: it never changes a module's output.
  const worker = read("../../apps/web/scripts/parallel-transform.worker.mjs");
  assert.ok(worker.includes('from "./react-compiler-plugin.mjs"'));
  assert.ok(viteConfig.includes('from "./scripts/react-compiler-plugin.mjs"'));
  assert.ok(!viteConfig.includes("reactCompilerPreset"), "one definition of the compiler plugin");
  const pool = read("../../apps/web/scripts/parallel-transform.ts");
  for (const relaxed of ["retry", "setTimeout"])
    assert.ok(!pool.includes(relaxed), `the transform pool must not ${relaxed}`);
  assert.ok(
    viteConfig.includes(
      'process.env.VITEST === "true" ? process.env.SYNARA_WEB_TRANSFORM_CACHE_DIR?.trim() : undefined',
    ),
    "only Vitest may enable the transform cache",
  );
  // Only the stable browser lanes opt in: no build, release or nightly lane.
  assert.equal(workflow.match(/web-transform-cache:/g)?.length, 1);
  const browser = workflow.split("  browser:\n")[1].split("  build:\n")[0];
  assert.ok(
    browser.includes(
      "web-transform-cache: browser-${{ matrix.project }}-${{ strategy.job-index }}",
    ),
  );
  for (const other of [
    "../workflows/release.yml",
    "../workflows/release-platform.yml",
    "../workflows/ci-nightly.yml",
  ]) {
    const text = read(other);
    assert.ok(!text.includes("web-transform-cache"), other);
    assert.ok(!text.includes("SYNARA_WEB_TRANSFORM_CACHE_DIR"), other);
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
  const windows = workflow.split("  windows_process:\n")[1].split("  migration_lineage:\n")[0];
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
  const components = browserMatrix.filter(({ project }) => project === "components");
  assert.deepEqual(components.map(({ shard }) => shard).sort(), ["1/3", "2/3", "3/3"]);
  // Duplicating a child shard would leave its sibling's tests out of a green gate.
  assert.deepEqual(components.flatMap(({ shardA, shardB }) => [shardA, shardB]).sort(), [
    "1/6",
    "2/6",
    "3/6",
    "4/6",
    "5/6",
    "6/6",
  ]);
  assert.deepEqual(
    browserMatrix
      .filter(({ project }) => project !== "components")
      .map(({ project, shardA, shardB }) => [project, shardA, shardB]),
    [
      ["chat-follow", undefined, undefined],
      ["chat-projects", "1/1", "1/1"],
      ["chat-workflows", "1/1", "1/1"],
    ],
  );
  assert.deepEqual(
    jobs.browser.steps
      .find((step) => step.parallel)
      ?.parallel.map((step) => step.env.VITEST_BROWSER_CHAT_SLICE),
    ["a", "b"],
  );
  const runtime = jobs.browser.steps.find((step) => step.name === "Install browser test runtime");
  const cache = jobs.browser.steps.find((step) => step.name === "Cache Chromium headless shell");
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
