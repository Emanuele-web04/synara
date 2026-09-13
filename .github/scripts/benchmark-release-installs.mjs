import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

// Matched release/device installation semantics: every sample ignores lifecycle
// scripts, unlike the normal PR installation experiment. No caches are reused.
const root = process.cwd();
const output = join(process.env.RUNNER_TEMP, "release-install-benchmark");
mkdirSync(output, { recursive: true });
const directories = [
  ".",
  "scripts",
  ...["apps", "packages"].flatMap((parent) =>
    readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`),
  ),
];
const lock = readFileSync("bun.lock", "utf8");
const results = [];
function run(bin, args, env = {}) {
  const started = performance.now();
  const result = spawnSync(bin, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
    timeout: 600_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${bin} failed: ${result.error ?? result.status}`);
  return (performance.now() - started) / 1000;
}
try {
  for (const [index, profile] of [
    "full",
    "runtime",
    "device",
    "device",
    "runtime",
    "full",
  ].entries()) {
    for (const directory of directories)
      rmSync(resolve(root, directory, "node_modules"), { recursive: true, force: true });
    const cache = join(output, `cache-${index}`);
    const seconds = run("node", [".github/scripts/ci-install.mjs", profile, "--ignore-scripts"], {
      BUN_INSTALL_CACHE_DIR: cache,
    });
    if (readFileSync("bun.lock", "utf8") !== lock) throw new Error("Frozen lockfile changed");
    results.push({ profile, sample: index + 1, seconds });
    console.log(`RELEASE_INSTALL_BENCHMARK ${JSON.stringify(results.at(-1))}`);
    if (profile === "device") run("bun", ["run", "test:device:probe"]);
    if (index === 3) {
      const runtimes = spawnSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
        encoding: "utf8",
      });
      if (runtimes.status !== 0) throw new Error("Could not inspect simulator availability");
      const devices = JSON.parse(runtimes.stdout).devices;
      if (
        Object.entries(devices).some(
          ([name, devices]) => name.includes("SimRuntime.iOS-") && devices.length,
        )
      ) {
        run("bun", ["run", "test:device"]);
      } else console.log("No bootable iOS device; compile/probe still ran.");
    }
    rmSync(cache, { recursive: true, force: true });
  }
} finally {
  writeFileSync(
    join(output, "results.json"),
    JSON.stringify(
      {
        source: process.env.GITHUB_SHA,
        platform: process.platform,
        arch: process.arch,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
