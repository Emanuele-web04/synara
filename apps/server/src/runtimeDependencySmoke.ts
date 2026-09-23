// FILE: runtimeDependencySmoke.ts
// Purpose: Exercises lazy runtime imports inside the packaged app without starting provider sessions.
// Layer: Release verification entrypoint

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";

import { loadAcpSdk } from "./provider/acp/AcpSdk.ts";
import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk.ts";

// Keep these imports external, just like the server. Running this entrypoint
// from app.asar exposes missing peers that the development install can hide.
await loadAcpSdk();
await loadClaudeAgentSdk();
await import("@earendil-works/pi-coding-agent");
await import("open");
await import("node-pty");
await import("@xterm/headless");
// The KWin backend resolves the session-bus client through createRequire on a
// Linux desktop's first real use; a missing package must fail here instead.
createRequire(import.meta.url)("dbus-next");

const { parsePatchFiles } = await import("@pierre/diffs");
const patches = parsePatchFiles(
  "diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-before\n+after\n",
);
assert.equal(patches[0]?.files[0]?.name, "smoke.txt");
console.log("Packaged runtime dependency smoke passed.");
