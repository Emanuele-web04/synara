// Deterministic app-server protocol peer, launched as `node app-server` by the
// real Codex adapter. No model, credentials, network, or live application state.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const stateDir = process.env.CODEX_HOME;
if (
  !stateDir ||
  !path.isAbsolute(stateDir) ||
  stateDir !== process.env.CODEX_SQLITE_HOME ||
  [process.cwd(), process.env.USERPROFILE, process.env.HOME].includes(stateDir)
)
  throw new Error("Lifecycle fixture requires one isolated absolute Codex state directory.");

const threadId = "fixture-native-thread";
let turnCount = 0;
let activeTurn;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => write({ method, params });
const record = (event) =>
  fs.appendFileSync(path.join(stateDir, "protocol.jsonl"), `${JSON.stringify(event)}\n`);
const complete = (state = "completed") => {
  if (!activeTurn) return;
  const turnId = activeTurn;
  activeTurn = undefined;
  record({ type: "completed", turnId, state });
  notify("item/completed", {
    threadId,
    turnId,
    item: {
      type: "agentMessage",
      id: `message-${turnId}`,
      text: `Completed ${turnId}.`,
      phase: "final_answer",
    },
  });
  notify("turn/completed", {
    threadId,
    turn: { id: turnId, status: state, items: [], error: null },
  });
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  switch (request.method) {
    case "initialize":
      result = { userAgent: "synara-lifecycle-fixture" };
      break;
    case "account/read":
      result = { account: { type: "apiKey" }, requiresOpenaiAuth: false };
      break;
    case "thread/start":
    case "thread/resume":
      result = { thread: { id: threadId, turns: [] }, model: "gpt-5.6-sol" };
      break;
    case "thread/read":
      result = { thread: { id: threadId, turns: [] } };
      break;
    case "turn/start": {
      if (activeTurn) throw new Error("Overlapping provider turn/start calls");
      activeTurn = `fixture-turn-${++turnCount}`;
      const turnId = activeTurn;
      record({ type: "started", turnId });
      result = { turn: { id: turnId, status: "inProgress", items: [], error: null } };
      write({ id: request.id, result });
      notify("turn/started", { threadId, turn: result.turn });
      notify("item/agentMessage/delta", {
        threadId,
        turnId,
        itemId: `message-${turnId}`,
        delta: `Working on ${turnId}.`,
      });
      return;
    }
    case "turn/interrupt":
      complete("interrupted");
      break;
  }
  write({ id: request.id, result });
});

const timer = setInterval(() => {
  if (activeTurn && fs.existsSync(path.join(stateDir, `complete-${activeTurn}`))) complete();
}, 20);
process.stdin.on("end", () => {
  clearInterval(timer);
  process.exit(0);
});
