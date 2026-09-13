// Manual CI experiments: isolated checkouts/caches, never production state.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const output = join(root, "ci-benchmark-results");
mkdirSync(output, { recursive: true });
const report = { platform: process.platform, arch: process.arch, node: process.version, samples: [] };
const runtimeFilters = ["--filter", "./", "--filter", "@synara/cli...", "--filter", "@synara/desktop...", "--filter", "@synara/scripts..."];
const deviceFilters = ["--filter", "./", "--filter", "@synara/scripts..."];
function run(label, command, args, cwd = root, extraEnv = {}) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000,
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1", TURBO_CACHE: "local:rw", ...extraEnv },
  });
  const sample = { label, command: [command, ...args], seconds: (performance.now() - start) / 1000, status: result.status, error: result.error?.message };
  writeFileSync(join(output, `${label}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  console.log(JSON.stringify(sample));
  if (result.status !== 0) {
    console.error(`${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").slice(-60).join("\n"));
    process.exitCode = 1;
  }
  report.samples.push(sample);
  writeFileSync(join(output, "summary.json"), JSON.stringify(report, null, 2));
  return result.status === 0;
}
function timingReport(file, prefix) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  const files = {};
  const cases = [];
  for (const entry of json.testResults ?? []) {
    files[relative(root, entry.name).replaceAll("\\", "/")] = (entry.endTime - entry.startTime) / 1000;
    for (const test of entry.assertionResults ?? []) {
      if (test.status === "passed" || test.status === "failed") cases.push({ name: test.fullName, ms: test.duration, status: test.status });
    }
  }
  const data = { files, tests: json.numTotalTests, passed: json.numPassedTests, failed: json.numFailedTests, skipped: json.numPendingTests, slowest: cases.sort((a, b) => b.ms - a.ms).slice(0, 15) };
  writeFileSync(join(output, `${prefix}-timings.json`), JSON.stringify(data, null, 2));
  console.log(`${prefix.toUpperCase()}_TIMINGS ${JSON.stringify(data)}`);
}
const mode = process.argv[2];
if (mode === "install") {
  const modes = process.platform === "darwin" ? ["full", "runtime", "device"] : ["full", "runtime"];
  for (let round = 1; round <= 2; round++) {
    for (const profile of round === 1 ? modes : [...modes].reverse()) {
      const temp = mkdtempSync(join(tmpdir(), "synara-ci-install-"));
      const cwd = join(temp, "repo");
      const label = `${profile}-${round}`;
      if (!run(`${label}-checkout`, "git", ["worktree", "add", "--detach", cwd, "HEAD"])) continue;
      const filters = profile === "runtime" ? runtimeFilters : profile === "device" ? deviceFilters : [];
      const args = ["install", "--frozen-lockfile", ...filters];
      // Compare the existing macOS artifact/device install contract exactly.
      if (process.platform === "darwin") args.push("--ignore-scripts");
      const env = { BUN_INSTALL_CACHE_DIR: join(temp, "cache") };
      if (run(`${label}-install`, "bun", args, cwd, env)) {
        run(`${label}-lock`, "git", ["diff", "--exit-code", "--", "bun.lock", "package.json"], cwd);
        if (round === 2 && profile === "runtime") {
          run(`${label}-shared`, "bun", ["run", "--cwd", "packages/shared", "test", "src/windowsProcess.test.ts", "src/filesystemPlatform.test.ts", "src/processRuntime.test.ts"], cwd, env);
          run(`${label}-server`, "bun", ["run", "--cwd", "apps/server", "test", "src/processRunner.test.ts", "src/persistence/MigrationBackup.test.ts"], cwd, env);
          run(`${label}-desktop`, "bun", ["run", "--cwd", "apps/desktop", "test", "src/desktopMigrationRecovery.test.ts"], cwd, env);
          run(`${label}-pty`, process.platform === "win32" ? "bun" : "node", ["scripts/node-pty-smoke.mjs"], cwd, env);
        }
        if (round === 2 && profile === "device") run(`${label}-probe`, "bun", ["run", "test:device:probe"], cwd, env);
      }
      if (run(`${label}-cleanup`, "git", ["worktree", "remove", "--force", cwd])) rmSync(temp, { recursive: true, force: true });
    }
  }
} else if (mode === "linux") {
  run("install", "bun", ["install", "--frozen-lockfile"]);
  const serverJson = join(output, "server.json");
  run("server", "bunx", ["turbo", "run", "test", "--filter=@synara/cli", "--", "--reporter=json", `--outputFile=${serverJson}`]);
  try { timingReport(serverJson, "server"); } catch (error) { console.error(error.message); process.exitCode = 1; }
  run("browser-install", join(root, "apps/web/node_modules/.bin/playwright"), ["install", "--with-deps", "chromium"]);
  const browserJson = join(output, "browser.json");
  run("browser", "bun", ["run", "--cwd", "apps/web", "test:browser:ci", "--", "--project=chat-workflows", "--reporter=json", `--outputFile=${browserJson}`]);
  try { timingReport(browserJson, "browser"); } catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  throw new Error("Expected install or linux benchmark mode.");
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${report.platform}/${report.arch}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
