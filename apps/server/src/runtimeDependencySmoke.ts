// FILE: runtimeDependencySmoke.ts
// Purpose: Exercises lazy runtime imports inside the packaged app without starting provider sessions.
// Layer: Release verification entrypoint

import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runProcess } from "./processRunner.ts";
import { verifyRemoteTlsRuntime } from "./remoteTransport/runtimeSmoke";
import { verifyEditorLanguageRuntime } from "./editor/runtimeSmoke";

import { loadAcpSdk } from "./provider/acp/AcpSdk.ts";
import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk.ts";

// Exercise the actual sibling entry and its owned child, not an in-process import.
async function verifyOfflineCompactorRuntime(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "synara-compactor-runtime-smoke-"));
  const entry = fileURLToPath(new URL("./compactDatabase.mjs", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const options = {
    cwd: root,
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 16 * 1024,
    allowNonZeroExit: true,
  } as const;
  try {
    const usage = await runProcess(process.execPath, [entry], options);
    assert.equal(usage.timedOut, false);
    assert.equal(usage.code, 2, usage.stderr);
    assert.match(usage.stderr, /Usage: synara-compact-database/);
    assert.deepEqual(await readdir(root), []);

    const target = join(root, "state.sqlite");
    const source = new DatabaseSync(target);
    try {
      source.exec(`
        PRAGMA auto_vacuum=NONE;
        PRAGMA user_version=17;
        CREATE TABLE retained(value TEXT);
        INSERT INTO retained VALUES('packaged compactor row');
        CREATE TABLE churn(payload BLOB);
        INSERT INTO churn VALUES(zeroblob(8 * 1024 * 1024));
        DELETE FROM churn;
      `);
    } finally {
      source.close();
    }
    const before = (await stat(target)).size;
    const result = await runProcess(process.execPath, [entry, target], options);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Compacted /);
    const after = (await stat(target)).size;
    assert.ok(
      after < before,
      "Packaged compactor must replace the fixture with the verified copy.",
    );
    const verified = new DatabaseSync(target, { readOnly: true });
    try {
      assert.deepEqual(
        verified
          .prepare("SELECT value FROM retained")
          .all()
          .map((row) => row.value),
        ["packaged compactor row"],
      );
      assert.equal(verified.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(verified.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum, 2);
      assert.equal(verified.prepare("PRAGMA user_version").get()?.user_version, 17);
    } finally {
      verified.close();
    }
    assert.deepEqual(await readdir(root), ["state.sqlite"]);
    console.log(
      JSON.stringify({ check: "offline compactor runtime", passed: true, before, after }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await verifyRemoteTlsRuntime();
if (process.env.SYNARA_RUNTIME_SMOKE === "remote-tls") process.exit(0);

// Keep these imports external, just like the server. Running this entrypoint
// from app.asar exposes missing peers that the development install can hide.
await loadAcpSdk();
await loadClaudeAgentSdk();
await import("@earendil-works/pi-coding-agent");
await import("open");
await import("node-pty");
await import("@xterm/headless");
// Connectors load the MCP SDK's OAuth client on first use.
await import("@modelcontextprotocol/sdk/client/auth.js");

const { parsePatchFiles } = await import("@pierre/diffs");
const patches = parsePatchFiles(
  "diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-before\n+after\n",
);
assert.equal(patches[0]?.files[0]?.name, "smoke.txt");
await verifyEditorLanguageRuntime();
await verifyOfflineCompactorRuntime();
console.log("Packaged runtime dependency smoke passed.");
