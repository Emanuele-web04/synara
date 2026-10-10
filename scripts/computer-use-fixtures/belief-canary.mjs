#!/usr/bin/env node
// Canary runner. No Electron here: it preflights the staged app, checks the
// built bundle, prints the operator's LaunchServices command, and (with no
// flags) launches the canary app from /private/tmp in the background — the
// app never becomes frontmost and never switches the operator's Space —
// waits for it, and reports the readback table from its report.json.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const implementationDir = "/private/tmp/synara-cua-implementation";
const appPath = join(implementationDir, "Synara Cua Canary.app");
const resourcesPath = join(appPath, "Contents/Resources");
const helperPath = join(resourcesPath, "belief-probe");
const driverPath = join(resourcesPath, "cua-driver/cua-driver");
const entryPath = join(resourcesPath, "app/canary.cjs");
const dryReportPath = join(implementationDir, "belief-dry.json");
const entrySourcePath = join(root, "scripts/computer-use-fixtures/canary-main.ts");
const runDir = join(implementationDir, "canary-run-1");

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

function signatureFailure() {
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", appPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : errorMessage(error);
    return stderr.split("\n")[0] || "codesign --verify --strict failed";
  }
}

function prereqState() {
  const ok = [];
  const failures = [];

  if (isFile(helperPath)) ok.push(`helper: ok (${helperPath})`);
  else failures.push(`helper: missing ${helperPath}`);

  try {
    const dry = JSON.parse(readFileSync(dryReportPath, "utf8"));
    const stages = Array.isArray(dry && dry.stages) ? dry.stages : [];
    if (
      dry &&
      dry.dryRun === true &&
      stages.length === 6 &&
      stages.every((s) => s && s.posted === false)
    )
      ok.push("dry report: ok (6 stages, all dryRun and unposted)");
    else
      failures.push(
        `dry report: ${dryReportPath} must show dryRun true and 6 stages with posted=false`,
      );
  } catch (error) {
    failures.push(`dry report: cannot read ${dryReportPath}: ${errorMessage(error)}`);
  }

  if (isFile(entrySourcePath)) ok.push(`canary entry source: ok (${entrySourcePath})`);
  else failures.push(`canary entry source: missing ${entrySourcePath}`);

  if (!existsSync(appPath)) failures.push(`canary bundle: missing ${appPath}`);
  else {
    const signature = signatureFailure();
    if (signature) failures.push(`canary bundle: ${signature}`);
    else ok.push(`canary bundle: ok (codesign --verify --strict, ${appPath})`);
  }

  if (isFile(driverPath)) ok.push(`driver binary: ok (${driverPath})`);
  else failures.push(`driver binary: missing ${driverPath}`);

  return { ok, failures };
}

function checkPrereqs() {
  const { ok, failures } = prereqState();
  if (failures.length === 0) {
    for (const line of ok) console.log(line);
    console.log("prereqs ok");
    return 0;
  }
  for (const line of failures) console.error(line);
  console.error("prereqs failed");
  return 1;
}

function checkBundle() {
  const detail = (() => {
    if (!existsSync(appPath)) return `canary bundle: missing ${appPath}`;
    const signature = signatureFailure();
    if (signature) return `canary bundle: ${signature}`;
    const missing = [entryPath, helperPath].filter((path) => !existsSync(path));
    if (missing.length) return `canary bundle: missing ${missing.join(", ")}`;
    return null;
  })();
  if (detail) {
    console.error(detail);
    console.error("bundle failed");
    return 1;
  }
  console.log("bundle ok");
  return 0;
}

// The canary must launch without becoming frontmost or switching the
// operator's Space: -g suppresses activation, -n forces a new instance, -W
// makes `open` wait for the run to exit. One flag list feeds both the
// printed operator command and the real spawn so they can never diverge.
const CANARY_OPEN_FLAGS = ["-g", "-n", "-W"];

export function canaryOpenArgs(app, envAssignment) {
  return [...CANARY_OPEN_FLAGS, "-a", app, "--env", envAssignment];
}

function printLaunchCommand() {
  console.log(
    `open ${canaryOpenArgs('"$HOME/Applications/Synara Cua Canary.app"', `SYNARA_CUA_CANARY_DIR=${runDir}`).join(" ")}`,
  );
}

function launch() {
  if (checkPrereqs() !== 0) return 1;
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const launched = spawnSync(
    "/usr/bin/open",
    canaryOpenArgs(appPath, `SYNARA_CUA_CANARY_DIR=${runDir}`),
    { stdio: "inherit" },
  );
  if (launched.error) {
    console.error(`canary launch failed: ${errorMessage(launched.error)}`);
    return 1;
  }
  if (launched.status !== 0) {
    console.error(`canary launch failed: open exited ${launched.status}`);
    return 1;
  }
  const reportPath = join(runDir, "report.json");
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(`canary launch failed: cannot read ${reportPath}: ${errorMessage(error)}`);
    return 1;
  }
  const phases = Array.isArray(report && report.phases) ? report.phases : [];
  console.log(`${"phase".padEnd(10)} ${"electronReadback".padEnd(28)} result`);
  for (const phase of phases) {
    const readback =
      typeof phase?.electronReadback === "string" ? phase.electronReadback : "(none)";
    const result = phase?.electronReadback === phase?.typed ? "pass" : "fail";
    console.log(`${String(phase?.phase ?? "?").padEnd(10)} ${readback.padEnd(28)} ${result}`);
  }
  console.log(`canary summary: ${report?.summary ?? "none"}`);
  return 0;
}

function cli() {
  const mode = process.argv[2];
  if (mode === undefined) process.exit(launch());
  if (mode === "--check") process.exit(checkPrereqs());
  if (mode === "--check-bundle") process.exit(checkBundle());
  if (mode === "--print") {
    printLaunchCommand();
    process.exit(0);
  }
  console.error(`belief-canary: unknown argument ${mode}`);
  console.error(
    "usage: node scripts/computer-use-fixtures/belief-canary.mjs [--check|--check-bundle|--print]",
  );
  process.exit(2);
}

// Importing this module for its launch-argument helpers must never launch.
const invokedAsScript =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) cli();
