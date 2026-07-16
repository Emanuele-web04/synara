// Synara agent gateway stdio<->HTTP MCP proxy (generated file, do not edit).
const url = process.env.SYNARA_AGENT_GATEWAY_URL;
const token = process.env.SYNARA_AGENT_GATEWAY_TOKEN;

if (!url || !token) {
  process.stderr.write("SYNARA_AGENT_GATEWAY_URL and SYNARA_AGENT_GATEWAY_TOKEN are required.\n");
  process.exit(1);
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function forward(line) {
  let id = null;
  try {
    const parsed = JSON.parse(line);
    if (parsed && (typeof parsed.id === "string" || typeof parsed.id === "number")) {
      id = parsed.id;
    }
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + token,
      },
      body: line,
    });
    if (response.status === 202) {
      return;
    }
    const payload = await response.json();
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) {
      if (message && typeof message === "object") {
        writeMessage(message);
      }
    }
  } catch (error) {
    if (id !== null) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Synara gateway request failed: " + String(error) },
      });
    }
  }
}

let queue = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      // Serialize forwards so responses keep the request order.
      queue = queue.then(() => forward(line));
    }
  }
});
process.stdin.on("end", () => {
  queue.then(() => process.exit(0));
});
