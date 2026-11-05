// FILE: runtimeDependencySmoke.ts
// Purpose: Exercises lazy runtime imports inside the packaged app without starting provider sessions.
// Layer: Release verification entrypoint

import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
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
// An import alone misses Pi's lazy OpenAI client and its transitive peers.
// Block real traffic even if the SDK stops honoring its supplied fetch.
const require = createRequire(import.meta.url);
const http = require("node:http") as typeof import("node:http");
const https = require("node:https") as typeof import("node:https");
const net = require("node:net") as typeof import("node:net");
const tls = require("node:tls") as typeof import("node:tls");
const originalTransport = {
  fetch: globalThis.fetch,
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
  socketConnect: net.Socket.prototype.connect,
  tlsConnect: tls.connect,
};
const denyNetwork = (): never => {
  throw new Error("Real network access is forbidden in the Pi runtime smoke.");
};
const root = await mkdtemp(join(tmpdir(), "synara-pi-runtime-smoke-"));
try {
  globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });
  http.request = denyNetwork;
  http.get = denyNetwork;
  https.request = denyNetwork;
  https.get = denyNetwork;
  net.Socket.prototype.connect = denyNetwork;
  tls.connect = denyNetwork;
  syncBuiltinESMExports();

  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const token = "synthetic-packaged-smoke-token";
  const authPath = join(root, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      openai: {
        type: "oauth",
        access: token,
        refresh: "synthetic-packaged-smoke-refresh",
        expires: 4102444800000,
        clientId: "synthetic-client",
        scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
      },
    }),
    { mode: 0o600 },
  );
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
    // Do not enumerate ambient credentials or refresh any provider on startup.
    refreshOnCreate: false,
  });
  const model = runtime.getModel("openai", "gpt-5.4");
  assert(model, "Missing packaged OpenAI smoke model.");
  let requests = 0;
  const sentinel = "synthetic packaged smoke stop";
  const completed = await runtime.complete(
    model,
    { messages: [{ role: "user", content: "offline smoke", timestamp: 0 }] },
    {
      apiKey: token,
      env: {},
      maxRetries: 0,
      signal: AbortSignal.timeout(5_000),
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          requests++;
          const request =
            typeof input === "string"
              ? new Request(input, init)
              : input instanceof URL
                ? new Request(input.href, init)
                : new Request(input, init);
          const body = (await request.json()) as { model?: string; stream?: boolean };
          assert(
            request.url === "https://api.openai.com/v1/responses",
            "Unexpected smoke endpoint.",
          );
          // Boolean assertions cannot include an unexpected credential in a diff.
          assert(
            request.headers.get("authorization") === `Bearer ${token}`,
            "Unexpected smoke auth.",
          );
          assert(body.model === model.id && body.stream === true, "Unexpected smoke request body.");
          return Response.json(
            { error: { message: sentinel, type: "invalid_request_error" } },
            { status: 400 },
          );
        },
        { preconnect: denyNetwork },
      ),
    },
  );
  assert.equal(requests, 1, "The packaged OpenAI client must dispatch once without retrying.");
  assert(
    completed.stopReason === "error" && completed.errorMessage?.includes(sentinel),
    "The packaged OpenAI client must propagate the synthetic response.",
  );
} finally {
  globalThis.fetch = originalTransport.fetch;
  http.request = originalTransport.httpRequest;
  http.get = originalTransport.httpGet;
  https.request = originalTransport.httpsRequest;
  https.get = originalTransport.httpsGet;
  net.Socket.prototype.connect = originalTransport.socketConnect;
  tls.connect = originalTransport.tlsConnect;
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
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
