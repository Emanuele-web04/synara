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
let token = process.env.SYNARA_AGENT_GATEWAY_TOKEN;
let bootstrapToken = process.env.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN;
const active = Boolean(url && (token || bootstrapToken));
const BOOTSTRAP_TIMEOUT_MS = 5000;
let tokenResolution;
let bootstrapController;
let bootstrapTimeout;
const activeRequests = new Map();
const activeControllers = new Set();
const inFlight = new Set();
let outputQueue = Promise.resolve();

function writeMessage(message) {
  outputQueue = outputQueue.then(() => {
    process.stdout.write(JSON.stringify(message) + "\\n");
  });
  return outputQueue;
}

function requestKey(id) {
  return typeof id === "string" || typeof id === "number"
    ? typeof id + ":" + String(id)
    : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestKeyForMessage(message) {
  if (!isRecord(message)) return null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return null;
  return requestKey(message.id);
}

function cancelledRequestKey(message) {
  if (
    !isRecord(message) ||
    "id" in message ||
    message.jsonrpc !== "2.0" ||
    message.method !== "notifications/cancelled" ||
    !isRecord(message.params)
  ) {
    return null;
  }
  return requestKey(message.params.requestId);
}

function localInactiveResponse(message) {
  const id = isRecord(message) && "id" in message ? message.id : undefined;
  if (id === undefined) return [];
  // Antigravity installs this proxy through a global, secret-free plugin. A
  // CLI launched outside Synara therefore sees a valid empty MCP server
  // instead of a noisy failed integration. Synara-managed processes receive
  // credentials in their own environment and use the forwarding path below.
  if (message.method === "initialize") {
    return [
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: message.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "synara", version: "1.0.0" },
        },
      },
    ];
  }
  if (message.method === "ping") {
    return [{ jsonrpc: "2.0", id, result: {} }];
  }
  if (message.method === "tools/list") {
    return [{ jsonrpc: "2.0", id, result: { tools: [] } }];
  }
  return [
    {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Synara is not active for this Antigravity session." },
    },
  ];
}

async function resolveToken() {
  if (token) return token;
  if (!url || !bootstrapToken) return null;
  if (!tokenResolution) {
    const controller = new AbortController();
    bootstrapController = controller;
    bootstrapTimeout = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
    bootstrapTimeout.unref?.();
    tokenResolution = (async () => {
      const bootstrapUrl = new URL(url);
      bootstrapUrl.pathname = bootstrapUrl.pathname.replace(/\\/$/, "") + "/bootstrap";
      bootstrapUrl.search = "";
      bootstrapUrl.hash = "";
      const response = await fetch(bootstrapUrl, {
        method: "POST",
        headers: { Authorization: "Bearer " + bootstrapToken },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("Synara gateway bootstrap failed with HTTP " + response.status);
      }
      const payload = await response.json();
      if (!isRecord(payload) || typeof payload.bearerToken !== "string") {
        throw new Error("Synara gateway bootstrap returned an invalid response");
      }
      token = payload.bearerToken;
      bootstrapToken = undefined;
      delete process.env.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN;
      return token;
    })().finally(() => {
      if (bootstrapController === controller) bootstrapController = undefined;
      if (bootstrapTimeout) clearTimeout(bootstrapTimeout);
      bootstrapTimeout = undefined;
    });
    // Begin the exchange before the provider can process a prompt or launch
    // command descendants. Keep the rejection observed even if no JSON-RPC
    // request has arrived yet; the first request receives the same failure.
    tokenResolution.catch(() => undefined);
  }
  return tokenResolution;
}

if (active && !token && bootstrapToken) {
  void resolveToken().catch(() => undefined);
}

async function forwardMessage(message, controller) {
  const hasId = isRecord(message) && "id" in message;
  const id = hasId ? message.id : null;
  if (!active) {
    return localInactiveResponse(message);
  }
  try {
    const resolvedToken = await resolveToken();
    if (!resolvedToken) return localInactiveResponse(message);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + resolvedToken,
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    if (response.status === 202) {
      return [];
    }
    const payload = await response.json();
    const messages = Array.isArray(payload) ? payload : [payload];
    return messages.filter((value) => value && typeof value === "object");
  } catch (error) {
    if (controller.signal.aborted || !hasId) return [];
    return [
      {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Synara gateway request failed: " + String(error) },
      },
    ];
  }
}

function startForward(message) {
  const controller = new AbortController();
  const key = requestKeyForMessage(message);
  // Keep the first owner of an in-flight id. A duplicate request is still
  // forwarded, but it must never steal the cancellation route from the
  // original long-running call.
  if (key !== null && !activeRequests.has(key)) activeRequests.set(key, controller);
  activeControllers.add(controller);
  const task = forwardMessage(message, controller).finally(() => {
    activeControllers.delete(controller);
    if (key !== null && activeRequests.get(key) === controller) {
      activeRequests.delete(key);
    }
  });
  return task;
}

function track(task) {
  inFlight.add(task);
  task.then(
    () => inFlight.delete(task),
    () => inFlight.delete(task),
  );
}

function handleLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) {
    return writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  }

  // Register every request before applying cancellations, so a cancellation
  // embedded in the same batch is immediate regardless of entry order.
  const forwards = messages.map((message) => startForward(message));
  for (const message of messages) {
    const key = cancelledRequestKey(message);
    if (key !== null) activeRequests.get(key)?.abort();
  }

  return Promise.all(forwards).then((responseGroups) => {
    const responses = responseGroups.flat();
    if (responses.length === 0) return;
    return writeMessage(Array.isArray(parsed) ? responses : responses[0]);
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      // JSON-RPC responses may arrive out of order. Keeping each forward
      // independent lets cancellation and ping bypass a slow tool call.
      track(Promise.resolve(handleLine(line)));
    }
  }
});
process.stdin.on("end", async () => {
  // Give already-issued cancellation notifications and short responses one
  // event-loop turn to reach the gateway, then abort anything still hung.
  bootstrapController?.abort();
  await Promise.race([
    Promise.allSettled(Array.from(inFlight)),
    new Promise((resolve) => setTimeout(resolve, 100)),
  ]);
  for (const controller of activeControllers) controller.abort();
  await Promise.allSettled(Array.from(inFlight));
  await outputQueue.catch(() => undefined);
  process.exit(0);
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
