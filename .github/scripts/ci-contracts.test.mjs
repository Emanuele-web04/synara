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
  assert.ok(setup.includes("steps.modules.outputs.cache-hit != 'true'"));
  assert.ok(setup.includes("inputs.turbo == 'true'"));
  const turbo = JSON.parse(read("../../turbo.json"));
  assert.equal(turbo.tasks.test.cache, false);
  assert.equal(turbo.tasks.typecheck.cache, false);
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
  for (const shard of ["1/3", "2/3", "3/3"])
    assert.ok(workflow.includes(`shard: ${shard}`), `browser ${shard}`);
  for (const project of ["chat-follow", "chat-projects", "chat-workflows"])
    assert.ok(workflow.includes(`project: ${project}`), project);
  const browser = workflow.split("  browser:\n")[1].split("  build:\n")[0];
  assert.ok(browser.includes("./node_modules/.bin/playwright install chromium"));
  assert.ok(!browser.includes("playwright install --with-deps chromium"));
});

test("three ChatView partitions are complementary and reject quarantined geometry", () => {
  const config = read("../../apps/web/vitest.browser.ci.config.ts");
  const stable = read("../../apps/web/vitest.browser.stable.config.ts");
  const follow = config.match(/const followPattern = "(.+)";/)?.[1];
  const project = config.match(/const projectPattern = "(.+)";/)?.[1];
  const quarantine = stable.match(/testNamePattern: \/(.+)\/,/)?.[1];
  assert.ok(follow);
  assert.ok(project);
  assert.ok(quarantine);
  assert.ok(config.includes("${stablePattern.source}(?=.*${followPattern})"));
  assert.ok(
    config.includes("${stablePattern.source}(?!.*${followPattern})(?=.*${projectPattern})"),
  );
  assert.ok(
    config.includes("${stablePattern.source}(?!.*${followPattern})(?!.*${projectPattern})"),
  );
  const partitions = [
    new RegExp(`${quarantine}(?=.*${follow})`),
    new RegExp(`${quarantine}(?!.*${follow})(?=.*${project})`),
    new RegExp(`${quarantine}(?!.*${follow})(?!.*${project})`),
  ];
  for (const title of [
    "restores streaming follow",
    "keeps scroll anchor stable",
    "renders tool activity",
    "creates a project",
    "new worktree",
    "approval already answered",
    "queued composer request",
    "unknown future stable case",
  ]) {
    assert.equal(partitions.filter((pattern) => pattern.test(title)).length, 1, title);
    const tagged = `[geometry:linux] ${title}`;
    assert.equal(
      partitions.some((pattern) => pattern.test(tagged)),
      false,
      tagged,
    );
  }
});
