#!/usr/bin/env node
// FILE: wandyMcp.mjs
// Purpose: Synara stdio MCP entry for the private Wandy runtime package.
// Layer: Desktop helper launcher

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromHere = createRequire(import.meta.url);

// Standalone copy of wandyRuntimeRelativeParts in packages/shared/src/wandy.ts:
// this file is staged into dist-electron and runs without workspace imports.
// Keep the two tables in sync.
const PLATFORM_RUNTIME_RELATIVE_PATHS = {
  "darwin-arm64": ["dist", "Wandy.app", "Contents", "MacOS", "Wandy"],
  "linux-arm64": ["dist", "linux", "arm64", "wandy"],
  "linux-x64": ["dist", "linux", "amd64", "wandy"],
  "win32-arm64": ["dist", "windows", "arm64", "wandy.exe"],
  "win32-x64": ["dist", "windows", "amd64", "wandy.exe"],
};

function fail(message) {
  console.error(`[Synara Wandy] ${message}`);
  process.exit(1);
}

function resolveWandyPackageRoot() {
  const configured = process.env.SYNARA_WANDY_PACKAGE_ROOT?.trim();
  if (configured && existsSync(path.join(configured, "package.json"))) {
    return configured;
  }

  try {
    const packageJsonPath = requireFromHere.resolve("@t3tools/wandy/package.json");
    return path.dirname(packageJsonPath);
  } catch {
    return null;
  }
}

function resolveBundledRuntime(packageRoot) {
  const configured = process.env.SYNARA_WANDY_RUNTIME_PATH?.trim();
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

const packageRoot = resolveWandyPackageRoot();
if (!packageRoot) {
  fail("Wandy runtime is unavailable. Run `bun install` in the Synara repo checkout.");
}

const runtimePath = resolveBundledRuntime(packageRoot);
if (!runtimePath) {
  fail(`Missing Wandy runtime for ${process.platform}-${process.arch} under ${packageRoot}.`);
}

spawnAndExit(runtimePath, ["mcp"]);
