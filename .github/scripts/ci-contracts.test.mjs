import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = read("../workflows/ci.yml");
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
test("filtered scopes preserve lifecycle scripts and the scripts workspace links", () => {
  assert.ok(
    setup.includes(
      "static) bun install --frozen-lockfile --filter './' --filter '@synara/scripts'",
    ),
  );
  assert.ok(setup.includes("runtime) bun install --frozen-lockfile --filter '!@synara/marketing'"));
  assert.ok(!setup.includes("--ignore-scripts"));
  assert.ok(setup.includes("runner.os != 'Windows' && inputs.scope == 'full'"));
  assert.ok(setup.includes("inputs.turbo == 'true'"));
  const turbo = JSON.parse(read("../../turbo.json"));
  assert.equal(turbo.tasks.test.cache, false);
  assert.equal(turbo.tasks.typecheck.cache, false);
});
test("caches restore in every consumer and save from one owner per key", () => {
  const steps = Object.fromEntries(
    setup
      .split("\n    - name: ")
      .slice(1)
      .map((step) => [step.split("\n")[0], step]),
  );
  const modulesKey =
    "${{ runner.os }}-${{ runner.arch }}-bun-modules-v2-electron-${{ inputs.electron }}-${{ hashFiles('bun.lock', 'package.json') }}";
  // The Bun package archive shared the modules hash, so it missed whenever it was needed.
  assert.ok(!setup.includes("~/.bun/install/cache"));
  const restore = steps["Restore node_modules"];
  assert.ok(restore.includes("uses: actions/cache/restore@v5"));
  assert.ok(restore.includes("if: ${{ runner.os != 'Windows' && inputs.scope == 'full' }}"));
  assert.ok(restore.includes(`key: ${modulesKey}`));
  assert.ok(!restore.includes("restore-keys"), "modules restore stays exact-key only");
  const save = steps["Save node_modules"];
  assert.ok(save.includes("uses: actions/cache/save@v5"));
  for (const condition of [
    "runner.os != 'Windows'",
    "inputs.scope == 'full'",
    "inputs.save-modules == 'true'",
    "steps.modules.outputs.cache-hit != 'true'",
  ])
    assert.ok(save.includes(condition), condition);
  assert.ok(save.includes("key: ${{ steps.modules.outputs.cache-primary-key }}"));
  assert.equal(setup.match(/actions\/cache\/save@/g)?.length, 1);
  const actionDefault = setup.split("  save-modules:\n")[1].split("\n\n")[0];
  assert.ok(actionDefault.includes('default: "false"'), "restore-only unless a job opts in");
  // One saver per CI key: typecheck owns electron:false, Desktop Build owns electron:true.
  const savers = workflow
    .split(/\n  (?=[a-z_-]+:\n)/)
    .filter((job) => job.includes('save-modules: "true"'))
    .map((job) => job.split(":")[0]);
  assert.deepEqual(savers, ["static-typecheck", "build"]);
  assert.equal(workflow.match(/save-modules: "true"/g)?.length, 2);
  // Turbo: pull requests restore main's newest entry; only pushes to main save.
  const main = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  assert.ok(steps["Restore Turbo outputs"].includes("uses: actions/cache/restore@v5"));
  assert.ok(steps["Restore Turbo outputs"].includes(`inputs.turbo == 'true' && !(${main})`));
  assert.ok(steps["Cache Turbo outputs (main)"].includes("uses: actions/cache@v5"));
  assert.ok(steps["Cache Turbo outputs (main)"].includes(`inputs.turbo == 'true' && ${main}`));
  const saving = Object.entries(steps)
    .filter(([, step]) => step.includes("uses: actions/cache@"))
    .map(([name]) => name);
  assert.deepEqual(saving, ["Cache Turbo outputs (main)", "Cache Electron runtime"]);
});
test("Windows install uses the runner-volume cache without changing other platforms", () => {
  const install = setup.match(
    /- name: Install dependencies[\s\S]*?      run: \|\n([\s\S]*?)(?=\n    - name:)/,
  )?.[1];
  assert.ok(install);
  const command = install
    .split("\n")
    .map((line) => line.replace(/^        /, ""))
    .join("\n");
  for (const platform of ["Windows", "Linux", "macOS"]) {
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
          WORKSPACE_SCOPE: "runtime",
          BUN_INSTALL_CACHE_DIR: "/existing-cache",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("arg=--concurrent-scripts=1\n"), platform);
    const expectedCache =
      platform === "Windows" ? "/runner temp/bun-install-cache" : "/existing-cache";
    assert.ok(result.stdout.includes(`cache=${expectedCache}\n`), platform);
    assert.ok(
      result.stdout.includes(
        "arg=install\narg=--frozen-lockfile\narg=--filter\narg=!@synara/marketing\n",
      ),
      platform,
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
  // Pinned placement only moves whole files between shards; each shard stays serial.
  const server = JSON.parse(read("../../apps/server/package.json"));
  assert.equal(server.scripts.test, "vitest run --maxWorkers=1 --no-file-parallelism");
  const serverConfig = read("../../apps/server/vitest.config.ts");
  assert.ok(serverConfig.includes("sequence: { sequencer: PinnedShardSequencer }"));
  for (const shard of ["1/3", "2/3", "3/3"])
    assert.ok(workflow.includes(`shard: ${shard}`), `browser ${shard}`);
  for (const project of ["chat-follow", "chat-projects", "chat-workflows"])
    assert.ok(workflow.includes(`project: ${project}`), project);
  const browser = workflow.split("  browser:\n")[1].split("  build:\n")[0];
  assert.ok(browser.includes("./node_modules/.bin/playwright install chromium"));
  assert.ok(!browser.includes("playwright install --with-deps chromium"));
});
