/**
 * Stdio-to-HTTP proxy script for the Synara agent gateway.
 *
 * Some MCP clients (ACP agents without `mcpCapabilities.http`) can only spawn
 * stdio MCP servers. This module materializes a small self-contained script
 * (runnable by both Node and Bun via `process.execPath`) that forwards each
 * newline-delimited JSON-RPC message from stdin to the gateway's streamable
 * HTTP endpoint and writes responses back to stdout. The endpoint URL and the
 * per-thread bearer token arrive via environment variables so the script file
 * itself is identical for every session.
 *
 * @module agentGateway/stdioProxyScript
 */
import { Effect, FileSystem, Path } from "effect";

export const AGENT_GATEWAY_STDIO_PROXY_FILE_NAME = "agent-gateway-mcp-proxy.mjs";

// Kept dependency-free and ES2022-compatible: it must run on whichever
// node/bun binary happens to back `process.execPath`.
const STDIO_PROXY_SCRIPT = `// Synara agent gateway stdio<->HTTP MCP proxy (generated file, do not edit).
const url = process.env.SYNARA_AGENT_GATEWAY_URL;
const token = process.env.SYNARA_AGENT_GATEWAY_TOKEN;

if (!url || !token) {
  process.stderr.write("SYNARA_AGENT_GATEWAY_URL and SYNARA_AGENT_GATEWAY_TOKEN are required.\\n");
  process.exit(1);
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
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
  while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
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
`;

/**
 * Write (or refresh) the proxy script under the server state dir and return
 * its absolute path. Idempotent; called once at credentials-layer build.
 */
export const ensureAgentGatewayStdioProxyScript = Effect.fn(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scriptPath = path.join(stateDir, AGENT_GATEWAY_STDIO_PROXY_FILE_NAME);
  yield* fileSystem.makeDirectory(stateDir, { recursive: true });
  yield* fileSystem.writeFileString(scriptPath, STDIO_PROXY_SCRIPT);
  return scriptPath;
});
