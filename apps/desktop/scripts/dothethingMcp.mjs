#!/usr/bin/env node
// FILE: dothethingMcp.mjs
// Purpose: Synara stdio MCP entry for the private Do The Thing runtime package.
// Layer: Desktop helper launcher

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);

const PLATFORM_RUNTIME_RELATIVE_PATHS = {
  "darwin-arm64": ["dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"],
  "darwin-x64": ["dist", "Do The Thing.app", "Contents", "MacOS", "DoTheThing"],
  "linux-arm64": ["dist", "linux", "arm64", "dothething"],
  "linux-x64": ["dist", "linux", "amd64", "dothething"],
  "win32-arm64": ["dist", "windows", "arm64", "dothething.exe"],
  "win32-x64": ["dist", "windows", "amd64", "dothething.exe"],
};

function fail(message) {
  console.error(`[Synara Do The Thing] ${message}`);
  process.exit(1);
}

function resolveDoTheThingPackageRoot() {
  const configured = process.env.SYNARA_DOTHETHING_PACKAGE_ROOT?.trim();
  if (configured && existsSync(path.join(configured, "package.json"))) {
    return configured;
  }

  try {
    const packageJsonPath = requireFromHere.resolve("@t3tools/dothething/package.json");
    return path.dirname(packageJsonPath);
  } catch {
    return null;
  }
}

function resolveBundledRuntime(packageRoot) {
  const configured = process.env.SYNARA_DOTHETHING_RUNTIME_PATH?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }

  const platformKey = `${process.platform}-${process.arch}`;
  const relativeParts = PLATFORM_RUNTIME_RELATIVE_PATHS[platformKey];
  if (!relativeParts) {
    return null;
  }

  const candidate = path.join(packageRoot, ...relativeParts);
  return existsSync(candidate) ? candidate : null;
}

function spawnAndExit(executable, executableArgs) {
  const child = spawn(executable, executableArgs, {
    stdio: "inherit",
    windowsHide: false,
  });

  child.on("error", (error) => {
    fail(`Failed to start ${executable}: ${error.message}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

const args = process.argv.slice(2);
const command = args[0] ?? "mcp";
if (command !== "mcp") {
  fail(`Unsupported command "${command}". This launcher only supports "mcp".`);
}

const packageRoot = resolveDoTheThingPackageRoot();
if (!packageRoot) {
  fail("Do The Thing runtime is unavailable. Run `bun install` in the Synara repo checkout.");
}

const runtimePath = resolveBundledRuntime(packageRoot);
if (!runtimePath) {
  fail(
    `Missing Do The Thing runtime for ${process.platform}-${process.arch} under ${packageRoot}.`,
  );
}

spawnAndExit(runtimePath, ["mcp"]);
