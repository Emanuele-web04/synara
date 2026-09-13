import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const patterns = manifest.workspaces.packages ?? manifest.workspaces;
const dirs = patterns.flatMap((pattern) => {
  if (!pattern.endsWith("/*")) return [pattern];
  const parent = pattern.slice(0, -2);
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
});
const lock = readFileSync("bun.lock", "utf8");
const results = [];
const output = resolve(process.env.RUNNER_TEMP, "install-benchmark");
mkdirSync(output, { recursive: true });

function command(bin, args, env = {}) {
  const started = performance.now();
  const result = spawnSync(bin, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    timeout: 600_000,
    shell: false,
  });
  const seconds = (performance.now() - started) / 1000;
  if (result.error || result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed: ${result.error ?? result.status}`);
  }
  return seconds;
}

function cleanModules() {
  for (const dir of [".", ...dirs]) {
    const path = resolve(root, dir, "node_modules");
    if (!path.startsWith(`${root}/`) && !path.startsWith(`${root}\\`)) {
      throw new Error(`Unsafe cleanup path: ${path}`);
    }
    rmSync(path, { recursive: true, force: true });
  }
}

const profiles = {
  full: [],
  runtime: ["--filter", "!@synara/marketing"],
  device: ["--filter", "@synara/scripts"],
};
const order = ["full", "runtime", "runtime", "full"];
if (process.platform === "darwin") order.push("device");
try {
  for (const [sample, profile] of order.entries()) {
    cleanModules();
    const cache = join(output, `cache-${sample}`);
    console.log(`::group::Cold installation ${sample + 1}: ${profile}`);
    const seconds = command("bun", ["install", "--frozen-lockfile", ...profiles[profile]], {
      BUN_INSTALL_CACHE_DIR: cache,
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    });
    if (readFileSync("bun.lock", "utf8") !== lock) throw new Error("Frozen lockfile changed");
    results.push({ profile, sample: sample + 1, seconds });
    console.log(`INSTALL_BENCHMARK ${JSON.stringify(results.at(-1))}`);
    console.log("::endgroup::");
    if (profile === "runtime" && sample === 1) {
      command("bun", ["run", "--cwd", "packages/shared", "test", "src/windowsProcess.test.ts", "src/platformProcess.test.ts", "src/processRuntime.test.ts", "src/filesystemPlatform.test.ts"]);
      command("bun", ["run", "--cwd", "apps/desktop", "test", "src/desktopMigrationRecovery.test.ts"]);
    }
    if (profile === "device") command("bun", ["run", "test:device:probe"]);
    rmSync(cache, { recursive: true, force: true });
  }
} finally {
  writeFileSync(join(output, "results.json"), JSON.stringify({
    source: process.env.GITHUB_SHA,
    os: process.platform,
    arch: process.arch,
    node: process.version,
    bun: spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim(),
    results,
  }, null, 2) + "\n");
}
