// Opt-in native control-only probe: compare live settings with fresh spawn settings.
// Uses temporary state and a rejecting loopback endpoint; never enqueues a prompt.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

if (process.argv[2] !== "--run" || !process.argv[3]) {
  console.log(
    "Usage: bun apps/server/scripts/claude-context-window-probe.mjs --run /absolute/path/to/claude",
  );
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "synara-context-probe-"));
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  response.writeHead(403).end("Probe rejects all API requests");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;

async function inspect(window) {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const runtime = query({
    prompt: (async function* () {
      await pending;
    })(),
    options: {
      cwd: root,
      pathToClaudeCodeExecutable: process.argv[3],
      model: "claude-fable-5-1[1m]",
      env: {
        HOME: root,
        CLAUDE_CONFIG_DIR: root,
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: "probe-not-a-real-key",
        ANTHROPIC_BASE_URL: endpoint,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      abortController: controller,
      settingSources: [],
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      plugins: [],
      persistSession: false,
      settings: {
        disableAllHooks: true,
        autoCompactEnabled: true,
        ...(window === undefined ? {} : { autoCompactWindow: window }),
      },
    },
  });
  try {
    const read = async () => {
      const usage = await runtime.getContextUsage({ detail: "summary" });
      return { rawMaxTokens: usage.rawMaxTokens, autoCompactThreshold: usage.autoCompactThreshold };
    };
    const before = await read();
    await runtime.applyFlagSettings({
      autoCompactWindow: window === 200_000 ? 1_000_000 : 200_000,
    });
    const afterLive = await read();
    return { before, afterLive };
  } finally {
    clearTimeout(timer);
    runtime.close();
    release();
  }
}

try {
  const auto = await inspect(undefined);
  const pinned = await inspect(200_000);
  console.log(JSON.stringify({ auto, pinned, requests }, null, 2));
  assert.deepEqual(
    auto.afterLive,
    auto.before,
    "Native live-setting behavior changed; re-audit the workaround",
  );
  assert.deepEqual(pinned.afterLive, pinned.before);
  assert.notEqual(auto.before.rawMaxTokens, pinned.before.rawMaxTokens);
  assert.equal(
    requests.some((url) => /\/messages(?:\?|$)/u.test(url)),
    false,
    "No inference requests allowed",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
