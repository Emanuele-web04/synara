#!/usr/bin/env node
// Deterministic protocol peer. Only the CLI process is substituted: orchestration,
// persistence, approvals, provider adapter and network routes are the real app.
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.134.0");
  process.exit(0);
}
const root = process.env.HOME;
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const record = (value) =>
  fs.appendFileSync(path.join(root, "fixture-provider.jsonl"), `${JSON.stringify(value)}\n`);
let threadId = "fixture-thread";
let gatewayAuthorization;
let turnId;
let ticker;
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });
record({ kind: "process", pid: process.pid });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.method && request.id === 9900) {
    record({ kind: "approved", decision: request.result?.decision });
    return;
  }
  if (!request.method || request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "account/read") return reply({ account: { type: "apiKey" } });
  if (request.method === "model/list")
    return reply({
      data: [
        {
          id: "gpt-6-astra",
          model: "gpt-6-astra",
          displayName: "Fixture",
          isDefault: true,
          supportedReasoningEfforts: [],
        },
      ],
      nextCursor: null,
    });
  if (request.method.startsWith("thread/")) {
    if (request.method === "thread/start" || request.method === "thread/resume") {
      gatewayAuthorization =
        request.params?.config?.mcp_servers?.synara?.http_headers?.Authorization;
    }
    threadId = request.params?.threadId ?? threadId;
    return reply({ thread: { id: threadId, cwd: request.params?.cwd, turns: [] } });
  }
  if (request.method === "turn/start") {
    turnId = `fixture-turn-${Date.now()}`;
    const itemId = `${turnId}-message`;
    record({ kind: "turn", turnId, pid: process.pid });
    const approval = JSON.stringify(request.params?.input).includes("APPROVAL FIXTURE");
    const remoteMcp = JSON.stringify(request.params?.input).includes("REMOTE MCP FIXTURE");
    reply({ turn: { id: turnId } });
    setTimeout(() => {
      notify("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
      notify("item/started", { item: { type: "agentMessage", id: itemId, text: "" } });
      notify("item/agentMessage/delta", {
        itemId,
        delta: "REMOTE STREAM STARTED",
      });
      if (remoteMcp) {
        void (async () => {
          const plan = JSON.parse(
            fs.readFileSync(path.join(root, "mcp-fixture-plan.json"), "utf8"),
          );
          const results = [];
          for (const step of plan.steps) {
            const response = await fetch(plan.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: gatewayAuthorization,
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: results.length + 1,
                method: "tools/call",
                params: step,
              }),
            });
            results.push({ status: response.status, body: await response.json() });
          }
          // Only tool results are recorded. The thread-scoped bearer never leaves memory.
          fs.writeFileSync(path.join(root, "mcp-fixture-results.json"), JSON.stringify(results));
        })().catch(() =>
          fs.writeFileSync(
            path.join(root, "mcp-fixture-results.json"),
            JSON.stringify({ failed: true }),
          ),
        );
        return;
      }
      if (approval) {
        send({
          id: 9900,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "fixture-command",
            command: "echo isolated-fixture",
            cwd: root,
          },
        });
        return;
      }
      let text = "REMOTE STREAM STARTED";
      let connectorGapRecorded = false;
      ticker = setInterval(() => {
        if (!connectorGapRecorded && fs.existsSync(path.join(root, "connector-gap-fixture"))) {
          connectorGapRecorded = true;
          text += " — RECOVERED AFTER CONNECTOR RESTART";
          notify("item/agentMessage/delta", {
            itemId,
            delta: " — RECOVERED AFTER CONNECTOR RESTART",
          });
          record({ kind: "connector-gap", turnId, pid: process.pid });
        }
        if (!fs.existsSync(path.join(root, "finish-fixture-turn"))) return;
        clearInterval(ticker);
        notify("item/agentMessage/delta", {
          itemId,
          delta: " — COMPLETED WHILE CONTROLLER WAS STOPPED",
        });
        notify("item/completed", {
          item: {
            type: "agentMessage",
            id: itemId,
            text: `${text} — COMPLETED WHILE CONTROLLER WAS STOPPED`,
          },
        });
        notify("turn/completed", {
          turn: { id: turnId, status: "completed", items: [], error: null },
        });
        record({ kind: "completed", turnId, pid: process.pid });
      }, 50);
    }, 30);
    return;
  }
  if (request.method === "turn/interrupt") {
    clearInterval(ticker);
    record({ kind: "interrupted", turnId });
    reply({});
    notify("turn/completed", {
      turn: { id: turnId, status: "interrupted", items: [], error: null },
    });
    return;
  }
  reply({});
});
