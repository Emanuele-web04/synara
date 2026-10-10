// One paired cold-build experiment on the same Mac. Neither output enters a cache.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [baseline, outputDirectory, mode] = process.argv.slice(2);
const prepareOnly = mode === "--prepare-only";
assert(baseline && /^[a-f0-9]{40}$/.test(baseline), "Supply a full baseline commit.");
assert(!mode || prepareOnly, "Unknown benchmark option.");
assert(outputDirectory, "Supply an output directory.");
assert(prepareOnly || process.platform === "darwin", "Build benchmarks require macOS.");
const root = process.cwd();
const probePath = join(root, "scripts/computer-use-fixtures/probe-native-cancellation.mjs");
assert(existsSync(probePath), "Native driver probe is missing.");
const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = resolve(outputDirectory, "evidence");
mkdirSync(evidence, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "synara-cua-benchmark-"));
const releasePath = "packages/shared/src/cuaDriverRelease.json";
const provisionPath = "apps/desktop/scripts/provision-cua-driver.mjs";
const exportedPaths = [
  "package.json",
  releasePath,
  "apps/desktop/patches/cua-driver",
  "apps/desktop/scripts",
  "scripts/lib/build-timing.ts",
  "docs/computer-use-cua/CUA-LICENSE.txt",
];
const currentRelease = JSON.parse(readFileSync(join(root, releasePath), "utf8"));
const results: Array<{
  name: string;
  commit: string;
  cargoMs: number;
  sourceBuildMs: number;
  sdkDylibs: string[];
  probeCases: number;
}> = [];

async function build(script: string, env: NodeJS.ProcessEnv, logPath: string): Promise<string> {
  let log = "";
  writeFileSync(logPath, "");
  const child = spawn(
    process.execPath,
    [script, "--destination", join(env.CARGO_TARGET_DIR!, "staged")],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const record = (chunk: Buffer) => {
    log += chunk.toString();
    appendFileSync(logPath, chunk);
    process.stdout.write(chunk);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  await new Promise<void>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? accept() : reject(new Error(`Cua build failed: ${code ?? signal}`)),
    );
  });
  return log;
}

// Validate both archived inputs before starting any expensive compilation.
const snapshots = (
  [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const
).map(([name, commit]) => {
  const directory = join(work, name);
  const checkout = join(directory, "checkout");
  const target = join(directory, "target");
  const cargoHome = join(directory, "cargo-home");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(cargoHome);
  const archive = join(directory, "checkout.tar");
  writeFileSync(
    archive,
    execFileSync("git", ["archive", commit, ...exportedPaths], { maxBuffer: 64 * 1024 * 1024 }),
  );
  execFileSync("tar", ["-xf", archive, "-C", checkout]);
  const release = JSON.parse(readFileSync(join(checkout, releasePath), "utf8"));
  for (const key of ["source", "version", "nativeRevision", "rustVersion"])
    assert.equal(release[key], currentRelease[key], `A/B builds must share ${key}.`);
  assert(
    readFileSync(join(checkout, "docs/computer-use-cua/CUA-LICENSE.txt")).length > 0,
    "Cua license missing from benchmark snapshot.",
  );
  const patch = readFileSync(
    join(checkout, "apps/desktop/patches/cua-driver/0001-synara-native.patch"),
  );
  assert.equal(createHash("sha256").update(patch).digest("hex"), release.patchSha256);

  // Apply identical timing-only instrumentation to both archived provisioners.
  const script = join(checkout, provisionPath);
  const source = readFileSync(script, "utf8");
  const marker = '          "--release",';
  assert.equal(source.split(marker).length, 2, "Expected one Cargo release invocation.");
  writeFileSync(script, source.replace(marker, `${marker}\n          "--timings",`));
  console.log(`[cua-benchmark] prepared ${name}: ${commit}; license and patch verified`);
  return { name, commit, directory, target, cargoHome, script };
});

for (const { name, commit, directory, target, cargoHome, script } of prepareOnly ? [] : snapshots) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: target,
    CUA_DRIVER_RS_UPDATE_CHECK: "0",
  };
  delete env.SYNARA_CUA_ARTIFACT_DIR;
  delete env.SYNARA_CUA_SIGN_IDENTITY;
  console.log(`[cua-benchmark] ${name}: ${commit}; fresh Cargo home and target directory`);
  let log: string;
  try {
    log = await build(script, env, join(evidence, `${name}.log`));
  } finally {
    // Preserve compiler evidence even when later staging/provenance checks fail.
    const timings = join(target, "cargo-timings");
    if (existsSync(timings))
      cpSync(timings, join(evidence, `${name}-timings`), { recursive: true });
  }
  const stages = [...log.matchAll(/\[build-timing\] (\{[^\n]+\})/g)].map((match) =>
    JSON.parse(match[1]!),
  );
  const duration = (stage: string): number => {
    const record = stages.find((item) => item.stage === stage && item.event === "complete");
    assert(record && Number.isFinite(record.durationMs), `Missing successful ${stage} timing.`);
    return record.durationMs;
  };
  const files = readdirSync(target, { recursive: true }) as string[];
  const sdkDylibs = files.filter((file) => /libcua_driver_sdk[^/]*\.dylib$/.test(file));
  assert(
    files.some((file) => /libcua_driver_sdk[^/]*\.rlib$/.test(file)),
    "SDK Rust library missing.",
  );
  assert.equal(sdkDylibs.length > 0, name === "baseline", "Unexpected SDK dynamic-library output.");
  const driver = join(target, "staged", "cua-driver");
  const linkage = execFileSync("otool", ["-L", driver], { encoding: "utf8" });
  writeFileSync(join(evidence, `${name}-linkage.txt`), linkage);
  assert(!linkage.includes("libcua_driver_sdk"), "Driver unexpectedly requires the SDK dylib.");
  const probe = spawnSync(process.execPath, [probePath, driver], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  writeFileSync(join(evidence, `${name}-probe.json`), probe.stdout || "");
  writeFileSync(join(evidence, `${name}-probe.stderr`), probe.stderr || "");
  assert.equal(
    probe.status,
    0,
    `Driver probe failed: ${probe.error ?? probe.stderr ?? probe.stdout}`,
  );
  const report = JSON.parse(probe.stdout);
  assert(!report.failure, report.failure);
  assert.deepEqual(report.exit, { code: 0, signal: null }, "Driver did not shut down cleanly.");
  results.push({
    name,
    commit,
    cargoMs: duration("cua-cargo-build"),
    sourceBuildMs: duration("cua-source-build"),
    sdkDylibs,
    probeCases: report.cases.length,
  });
  writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`[cua-benchmark] ${JSON.stringify(results.at(-1))}`);
  rmSync(directory, { recursive: true, force: true });
}
if (!prepareOnly) {
  const savedMs = results[0]!.cargoMs - results[1]!.cargoMs;
  const summary = `Cua cold Cargo: baseline ${(results[0]!.cargoMs / 1000).toFixed(3)}s; candidate ${(results[1]!.cargoMs / 1000).toFixed(3)}s; saved ${(savedMs / 1000).toFixed(3)}s (${((savedMs / results[0]!.cargoMs) * 100).toFixed(1)}%). One sequential pair, same runner, fresh source/Cargo/target directories; not a repeated-sample guarantee.\n`;
  writeFileSync(join(evidence, "summary.txt"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}
rmSync(work, { recursive: true, force: true });
