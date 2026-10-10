#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { waitForSuccessfulPtyExit } from "./lib/node-pty-smoke.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const requireRoot =
  process.env.SYNARA_NODE_PTY_SMOKE_REQUIRE_ROOT?.trim() || resolve(repoRoot, "apps/server");
const requireFromTarget = createRequire(resolve(requireRoot, "package.json"));
const expectedOutput = "synara-node-pty-smoke";

function fail(message, detail) {
  console.error(`[node-pty-smoke] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

let nodePty;
try {
  nodePty = requireFromTarget("node-pty");
} catch (error) {
  fail("Failed to load node-pty.", error instanceof Error ? error.stack : String(error));
}

const isWindows = process.platform === "win32";
const shell = isWindows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
const args = isWindows ? ["/d", "/q"] : ["-lc", `printf '${expectedOutput}'`];

let terminal;
try {
  terminal = nodePty.spawn(shell, args, {
    cols: 80,
    rows: 24,
    cwd: requireRoot,
    env: process.env,
    name: isWindows ? "xterm-color" : "xterm-256color",
  });
} catch (error) {
  fail("Failed to spawn node-pty process.", error instanceof Error ? error.stack : String(error));
}

try {
  if (isWindows) {
    // Bun's ConPTY input/output wrappers are async and can miss a one-shot command's data; a real child PID proves the binding loaded
    if (!Number.isInteger(terminal.pid) || terminal.pid <= 0) {
      throw new Error("node-pty did not return a valid Windows process ID.");
    }
    terminal.kill();
  } else {
    await waitForSuccessfulPtyExit({
      terminal,
      expectedOutput,
      timeoutMs: 5_000,
    });
  }
  console.log("[node-pty-smoke] node-pty loaded and spawned successfully.");
  // the ConPTY reader thread can outlive the child — terminate explicitly once output and exit are verified
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
