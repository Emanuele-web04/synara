// Temporary native A/B harness. Artifacts stay outside the provenance-checked worktree.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const [mode, profile, platform, arch, target] = process.argv.slice(2);
const output = join(process.env.RUNNER_TEMP, "ci-native-results");
mkdirSync(output, { recursive: true });
const report = {
  mode,
  profile,
  platform: process.platform,
  arch: process.arch,
  source: process.env.GITHUB_SHA,
  samples: [],
};
function run(label, command, args) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 25 * 60_000,
    env: {
      ...process.env,
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
      TURBO_CACHE: "local:rw",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      SYNARA_PUBLISH_RELEASE: "false",
    },
  });
  writeFileSync(join(output, `${label}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  report.samples.push({
    label,
    command: [command, ...args],
    seconds: (performance.now() - start) / 1000,
    status: result.status,
    error: result.error?.message,
  });
  console.log(JSON.stringify(report.samples.at(-1)));
  if (result.status !== 0) {
    console.error(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").slice(-100).join("\n"),
    );
    throw new Error(`${label} failed; inspect the uploaded log.`);
  }
}
try {
  run("install", process.execPath, [
    ".github/scripts/install-workspace.mjs",
    profile,
    ...(mode === "windows" ? [] : ["--ignore-scripts"]),
  ]);
  run("frozen-integrity", "git", ["diff", "--exit-code"]);
  if (mode === "windows") {
    run("pty", "bun", ["scripts/node-pty-smoke.mjs"]);
    run("shared", "bun", [
      "run",
      "--cwd",
      "packages/shared",
      "test",
      "src/windowsProcess.test.ts",
      "src/filesystemPlatform.test.ts",
    ]);
    run("server", "bun", [
      "run",
      "--cwd",
      "apps/server",
      "test",
      "src/processRunner.test.ts",
      "src/persistence/MigrationBackup.test.ts",
    ]);
    run("desktop", "bun", [
      "run",
      "--cwd",
      "apps/desktop",
      "test",
      "src/backendShutdown.windows.integration.test.ts",
      "src/desktopMigrationRecovery.test.ts",
    ]);
  } else if (mode === "device") {
    run("device-probe", "bun", ["run", "test:device:probe"]);
    run("device-smoke", "bun", ["run", "test:device"]);
  } else if (mode === "artifact") {
    const version = JSON.parse(readFileSync("apps/server/package.json", "utf8")).version;
    const digest = createHash("sha256").update(readFileSync("bun.lock")).digest("hex");
    run("artifact", "bun", [
      "run",
      "dist:desktop:artifact",
      "--",
      "--platform",
      platform,
      "--target",
      target,
      "--arch",
      arch,
      "--build-version",
      version,
      "--source-commit",
      process.env.GITHUB_SHA,
      "--lockfile-sha256",
      digest,
      "--verbose",
    ]);
    const assets = join(process.env.RUNNER_TEMP, "ci-native-assets");
    mkdirSync(assets, { recursive: true });
    for (const name of readdirSync("release")) {
      if (/\.(?:dmg|zip|AppImage|exe|blockmap)$/.test(name) || /^latest.*\.yml$/.test(name))
        copyFileSync(join("release", name), join(assets, name));
    }
    run("provenance", process.execPath, [
      "scripts/write-release-artifact-provenance.ts",
      "--assets-dir",
      assets,
      "--platform",
      platform,
      "--arch",
      arch,
      "--target",
      target,
      "--version",
      version,
      "--source-commit",
      process.env.GITHUB_SHA,
      "--lockfile-sha256",
      digest,
      "--publication",
      "false",
      "--signed",
      "false",
      "--allow-unsigned-windows-publication",
      "false",
    ]);
    run("packaged-startup", process.execPath, [
      "scripts/verify-packaged-desktop-startup.ts",
      "--assets-dir",
      assets,
      "--platform",
      platform,
      "--arch",
      arch,
      "--version",
      version,
    ]);
  } else {
    throw new Error("Unknown benchmark mode");
  }
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, "summary.json"), JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
    );
}
