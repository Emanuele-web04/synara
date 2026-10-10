// Probe 2: hybrid steer escalation. Start a turn stuck on a long Bash call,
// queue a steer mid-flight, then interrupt(). Question: does the CLI deliver
// the queued steer right after the interrupt (auto-dispatching it as the next
// prompt with full conversation context), and how fast?
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...args) => console.log(`[${ts()}]`, ...args);

const cwd = mkdtempSync(join(tmpdir(), "steer-probe2-"));

let pushSteer;
const steerPushed = new Promise((resolve) => {
  pushSteer = resolve;
});

async function* prompt() {
  yield {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content:
        "Run `python3 -c 'import time; time.sleep(120); print(\"done\")'` with the Bash tool (single foreground call, do not background it, do not use Monitor). After it completes, reply exactly ALLDONE.",
    },
  };
  await steerPushed;
  log(">>> pushing steer message");
  yield {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content:
        "Change of plans: stop waiting. Reply with exactly STEERED and say which command you were running.",
    },
  };
  await new Promise(() => {});
}

const q = query({
  prompt: prompt(),
  options: {
    cwd,
    permissionMode: "bypassPermissions",
    pathToClaudeCodeExecutable: "/Users/emanueledipietro/.local/bin/claude",
    allowedTools: ["Bash"],
    maxTurns: 30,
  },
});

setTimeout(() => pushSteer(), 6000);
setTimeout(() => {
  log(">>> calling interrupt()");
  q.interrupt().then(
    () => log("interrupt() resolved"),
    (error) => log("interrupt() rejected:", String(error).slice(0, 120)),
  );
}, 14000);
const killer = setTimeout(() => {
  log("TIMEOUT — killing");
  process.exit(1);
}, 90000);

for await (const message of q) {
  if (message.type === "assistant") {
    const parts = message.message.content
      .map((block) =>
        block.type === "text"
          ? `text:${JSON.stringify(block.text.slice(0, 140))}`
          : block.type === "tool_use"
            ? `tool_use:${block.name}:${JSON.stringify(block.input).slice(0, 80)}`
            : block.type,
      )
      .join(" | ");
    log("assistant:", parts);
  } else if (message.type === "user") {
    const content = message.message.content;
    const summary = Array.isArray(content)
      ? content
          .map((block) =>
            block.type === "tool_result"
              ? `tool_result:${JSON.stringify(block.content).slice(0, 100)}`
              : block.type === "text"
                ? `text:${JSON.stringify(block.text.slice(0, 100))}`
                : block.type,
          )
          .join(" | ")
      : JSON.stringify(content).slice(0, 140);
    log("user(replay):", summary);
  } else if (message.type === "result") {
    log("RESULT:", message.subtype, JSON.stringify(message.result ?? "").slice(0, 200));
    // Keep listening: after an interrupted result the queued steer may start
    // a follow-up turn on the same session.
  } else if (message.type === "system") {
    log("system", message.subtype ?? "");
  } else {
    log(message.type, message.subtype ?? "");
  }
  if (message.type === "result" && JSON.stringify(message).includes("STEERED")) {
    log("steer answered — done");
    clearTimeout(killer);
    process.exit(0);
  }
}
