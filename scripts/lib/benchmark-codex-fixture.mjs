#!/usr/bin/env node
// Deterministic Codex app-server protocol peer for multi-thread resource benchmarking.
// Only the external LLM CLI is substituted: Synara orchestration, SQLite persistence,
// provider adapter, PTY terminals, diffs, Electron main/renderer/GPU are the real app.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.134.0");
  process.exit(0);
}

const root = process.env.SYNARA_BENCH_SIGNAL_DIR || process.env.HOME || "/tmp";
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

let threadId = "bench-thread";
let turnId = null;
let streamTimer = null;
let helperChild = null;
let chunkIndex = 0;

const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });

function stopHelper() {
  if (!helperChild) return;
  try {
    helperChild.kill("SIGTERM");
  } catch {
    // ignore already exited
  }
  helperChild = null;
}

function stopStreaming() {
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }
  stopHelper();
}

function spawnSimulatedAgentChild() {
  if (helperChild) return;
  // Lightweight child process simulating an agent-spawned dev server / test runner
  // so process-tree accounting captures agent-spawned descendants separately.
  helperChild = spawn(
    process.execPath,
    [
      "-e",
      "const buf = Buffer.alloc(4 * 1024 * 1024, 1); setInterval(() => { buf[0] = (buf[0] + 1) & 255; }, 1000);",
    ],
    {
      env: { ...process.env, SYNARA_BENCH_ROLE: "agent-child" },
      stdio: "ignore",
    },
  );
  helperChild.on("exit", () => {
    helperChild = null;
  });
}

const SEED_MARKDOWN = [
  "## Architecture Analysis\n\n",
  "Reviewed the workspace modules and identified three candidate hot paths across the renderer, terminal runtime, and provider lifecycle:\n\n",
  "1. **Terminal parking**: detached xterm instances stay subscribed to PTY output and DOM theme observers.\n",
  "2. **Server read model**: in-memory projections accumulate historical messages per touched thread.\n",
  "3. **Provider runtime retention**: idle provider CLIs wait up to 10 minutes before stopping.\n\n",
  "```ts\n",
  "export function measureBudget(threads: number, activeStreams: number) {\n",
  "  const baseMb = 280;\n",
  "  return { totalMb: baseMb + threads * 24 + activeStreams * 45, threads, activeStreams };\n",
  "}\n",
  "```\n\n",
  "All checks completed cleanly with zero regressions.\n",
];

const STREAM_CHUNKS = [
  "Analyzing module graph and inspecting active listeners across open panes. ",
  "Measured frame timing and heap retention under concurrent streaming load.\n\n",
  "```ts\nconst sample = { ts: Date.now(), listeners: 142, activeStreams: 4 };\n```\n\n",
  "- Verified incremental projection commits stay bounded under sustained token arrival.\n",
  "- Checking terminal scrollback buffer pressure and WebSocket frame coalescing.\n",
];

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request.method || request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });

  if (request.method === "account/read") {
    return reply({ account: { type: "apiKey" } });
  }
  if (request.method === "model/list") {
    return reply({
      data: [
        {
          id: "gpt-6-astra",
          model: "gpt-6-astra",
          displayName: "Benchmark Fixture",
          isDefault: true,
          supportedReasoningEfforts: [],
        },
      ],
      nextCursor: null,
    });
  }
  if (request.method.startsWith("thread/")) {
    threadId = request.params?.threadId ?? threadId;
    return reply({ thread: { id: threadId, cwd: request.params?.cwd, turns: [] } });
  }
  if (request.method === "turn/start") {
    stopStreaming();
    turnId = `bench-turn-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const itemId = `${turnId}-msg`;
    const inputText = JSON.stringify(request.params?.input ?? "");
    const markerMatch = inputText.match(/MARKER:([A-Za-z0-9_-]+)/);
    const marker = markerMatch ? markerMatch[1] : threadId;
    const stopFileMatch = inputText.match(/STOP_FILE:([^\s"\\]+)/);
    const stopFile = stopFileMatch ? stopFileMatch[1] : path.join(root, "stop-streaming");
    const isContinuous = inputText.includes("BENCH_STREAM_CONTINUOUS");
    const withChild = inputText.includes("BENCH_WITH_CHILD");

    reply({ turn: { id: turnId } });

    setTimeout(() => {
      notify("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
      notify("item/started", { item: { type: "agentMessage", id: itemId, text: "" } });

      if (!isContinuous) {
        let fullText = `[${marker}] `;
        notify("item/agentMessage/delta", { itemId, delta: fullText });
        let idx = 0;
        const seedTimer = setInterval(() => {
          if (idx >= SEED_MARKDOWN.length) {
            clearInterval(seedTimer);
            notify("item/completed", {
              item: { type: "agentMessage", id: itemId, text: fullText },
            });
            notify("turn/completed", {
              turn: { id: turnId, status: "completed", items: [], error: null },
            });
            return;
          }
          const delta = SEED_MARKDOWN[idx++];
          fullText += delta;
          notify("item/agentMessage/delta", { itemId, delta });
        }, 12);
        return;
      }

      if (withChild) {
        spawnSimulatedAgentChild();
      }

      let fullText = `[${marker}] Streaming benchmark turn started.\n\n`;
      notify("item/agentMessage/delta", { itemId, delta: fullText });
      chunkIndex = 0;

      streamTimer = setInterval(() => {
        if (fs.existsSync(stopFile)) {
          stopStreaming();
          const finalDelta = `\n[${marker}] Streaming completed cleanly.\n`;
          fullText += finalDelta;
          notify("item/agentMessage/delta", { itemId, delta: finalDelta });
          notify("item/completed", {
            item: { type: "agentMessage", id: itemId, text: fullText },
          });
          notify("turn/completed", {
            turn: { id: turnId, status: "completed", items: [], error: null },
          });
          return;
        }
        const delta = `[${marker}#${chunkIndex}] ${STREAM_CHUNKS[chunkIndex % STREAM_CHUNKS.length]}`;
        chunkIndex += 1;
        fullText += delta;
        notify("item/agentMessage/delta", { itemId, delta });
      }, 60);
    }, 20);
    return;
  }
  if (request.method === "turn/interrupt") {
    stopStreaming();
    reply({});
    notify("turn/completed", {
      turn: { id: turnId, status: "interrupted", items: [], error: null },
    });
    return;
  }
  reply({});
});

process.on("SIGTERM", () => {
  stopStreaming();
  process.exit(0);
});
process.on("SIGINT", () => {
  stopStreaming();
  process.exit(0);
});
