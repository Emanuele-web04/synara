import { createInterface } from "node:readline";
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let sessionCwd;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize")
    result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
  else if (request.method === "session/new") {
    sessionCwd = request.params.cwd;
    result = { sessionId: "fixture-session" };
  } else if (request.method === "session/load") result = {};
  else if (request.method === "session/prompt") {
    if (request.params.prompt.some((part) => part.type === "text" && part.text === "hang"))
      continue;
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fixture-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, sessionCwd }),
          },
        },
      },
    });
    result = { stopReason: "end_turn" };
  } else {
    write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Unsupported fixture method" },
    });
    continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
