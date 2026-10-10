// FILE: runtimeDependencySmoke.ts
// Purpose: Exercises lazy runtime imports inside the packaged app without starting provider sessions.
// Layer: Release verification entrypoint

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { loadAcpSdk } from "./provider/acp/AcpSdk.ts";
import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk.ts";

// Keep these imports external, just like the server. Running this entrypoint
// from app.asar exposes missing peers that the development install can hide.
await loadAcpSdk();
await loadClaudeAgentSdk();
// The SDK's capability probe uses its bundled executable even though normal
// sessions use the user's installed CLI. Exercise the real native payload,
// without authentication or starting a provider session, after packaging.
const require = createRequire(import.meta.url);
const nativeName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const nativeEntry = require.resolve(
  `${nativeName}/claude${process.platform === "win32" ? ".exe" : ""}`,
);
const nativeExecutable = nativeEntry.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
const nativeVersion = execFileSync(nativeExecutable, ["--version"], {
  encoding: "utf8",
  timeout: 30_000,
  windowsHide: true,
});
assert.match(nativeVersion, /Claude Code/);
await import("@earendil-works/pi-coding-agent");
await import("open");
await import("node-pty");
await import("@xterm/headless");

const { parsePatchFiles } = await import("@pierre/diffs");
const patches = parsePatchFiles(
  "diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-before\n+after\n",
);
assert.equal(patches[0]?.files[0]?.name, "smoke.txt");
console.log("Packaged runtime dependency smoke passed.");
