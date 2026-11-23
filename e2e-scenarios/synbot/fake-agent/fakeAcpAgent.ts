// A scripted ACP agent that stands in for a model in SynBot scenarios.
//
// Synara starts it as a provider binary. Every prompt is matched against the rules in
// `.state/script.json` (written by the scenario before it sends a message), and the matching
// rule's steps run in order: stream text, call a real MCP tool from the servers Synara passed in
// `session/new` (so `synara_bot_*` delegation really happens), sleep, or fail. Every prompt, tool
// call and tool result is appended to `.state/log.ndjson` so scenarios can assert on them.
//
// No model is called and no shell command runs.

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = process.env.SYNBOT_FAKE_STATE_DIR ?? nodePath.resolve(HERE, "../.state");
const SCRIPT_PATH = nodePath.join(STATE_DIR, "script.json");
const LOG_PATH = nodePath.join(STATE_DIR, "log.ndjson");

export type Step =
  | { readonly say: string }
  | { readonly think: string }
  | {
      readonly tool: string;
      readonly args?: unknown;
      readonly saveAs?: string;
      /** Call it on Synara's gateway even when the gateway did not offer it (a tamper attempt). */
      readonly force?: boolean;
    }
  | { readonly sleepMs: number }
  | { readonly stop: "end_turn" | "refusal" | "max_tokens" | "cancelled" }
  | { readonly error: string };

export interface Rule {
  /** Regular expression tested against the prompt text (case-insensitive). */
  readonly match?: string;
  /** Substring the session's working directory must contain. */
  readonly cwdIncludes?: string;
  /** Run this rule at most this many times per agent state directory. */
  readonly times?: number;
  readonly steps: ReadonlyArray<Step>;
}

export interface Script {
  readonly rules: ReadonlyArray<Rule>;
  readonly fallback?: ReadonlyArray<Step>;
}

interface McpServerConfig {
  readonly name: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: ReadonlyArray<{ name: string; value: string }>;
  readonly type?: string;
  readonly url?: string;
  readonly headers?: ReadonlyArray<{ name: string; value: string }>;
}

interface SessionState {
  readonly id: string;
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<McpServerConfig>;
  clients?: Promise<ReadonlyArray<{ name: string; client: ToolClient }>>;
  abort?: AbortController;
  modelId: string;
}

const log = (event: string, data: Record<string, unknown>) => {
  try {
    nodeFs.mkdirSync(STATE_DIR, { recursive: true });
    nodeFs.appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data })}\n`,
    );
  } catch {
    // Logging is best effort.
  }
};

const readScript = (): Script => {
  try {
    return JSON.parse(nodeFs.readFileSync(SCRIPT_PATH, "utf8")) as Script;
  } catch {
    return { rules: [], fallback: [{ say: "fake agent: no script" }] };
  }
};

const ruleUseCounts = (): Map<number, number> => {
  const counts = new Map<number, number>();
  try {
    for (const line of nodeFs.readFileSync(LOG_PATH, "utf8").split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as { event?: string; rule?: number };
      if (entry.event === "rule" && typeof entry.rule === "number") {
        counts.set(entry.rule, (counts.get(entry.rule) ?? 0) + 1);
      }
    }
  } catch {
    // No log yet.
  }
  return counts;
};

const pickSteps = (script: Script, text: string, cwd: string) => {
  const counts = ruleUseCounts();
  for (const [index, rule] of script.rules.entries()) {
    const found = rule.match ? new RegExp(rule.match, "is").exec(text) : [text];
    if (!found) continue;
    if (rule.cwdIncludes && !cwd.includes(rule.cwdIncludes)) continue;
    if (rule.times !== undefined && (counts.get(index) ?? 0) >= rule.times) continue;
    return { rule: index, steps: rule.steps, match: [...found] };
  }
  return { rule: -1, steps: script.fallback ?? [{ say: "ok" }], match: [] as string[] };
};

const lookup = (scope: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object") return (value as Record<string, unknown>)[key];
    return undefined;
  }, scope);

/** Replaces `{{path}}` in every string, reading `prompt`, `cwd` and saved tool results. */
const template = (value: unknown, scope: Record<string, unknown>): unknown => {
  if (typeof value === "string") {
    const whole = /^\{\{([^}]+)\}\}$/.exec(value);
    if (whole) return lookup(scope, whole[1]!.trim());
    return value.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
      const found = lookup(scope, path.trim());
      return typeof found === "string" ? found : JSON.stringify(found ?? null);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => template(entry, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, template(entry, scope)]),
    );
  }
  return value;
};

const promptText = (prompt: ReadonlyArray<{ type: string; text?: string }>) =>
  prompt
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");

interface ToolClient {
  listTools(): Promise<{ tools: ReadonlyArray<{ name: string }> }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

/** Synara's gateway is stateless JSON-RPC over `POST /mcp`; no MCP handshake is needed. */
const httpToolClient = (server: McpServerConfig): ToolClient => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value])),
  };
  let id = 0;
  const call = async (method: string, params: unknown) => {
    id += 1;
    const response = await fetch(server.url!, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result;
  };
  return {
    listTools: async () => (await call("tools/list", {})) as { tools: Array<{ name: string }> },
    callTool: (input) => call("tools/call", input),
  };
};

const connectMcp = async (servers: ReadonlyArray<McpServerConfig>) => {
  const connected: Array<{ name: string; client: ToolClient }> = [];
  for (const server of servers) {
    const client = new McpClient({ name: "synbot-fake-agent", version: "0.0.1" });
    try {
      if (server.url) {
        connected.push({ name: server.name, client: httpToolClient(server) });
        log("mcp_connected", { server: server.name, kind: "http" });
        continue;
      } else if (server.command) {
        const env = Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]));
        await client.connect(
          new StdioClientTransport({
            command: server.command,
            args: [...(server.args ?? [])],
            env: { ...(process.env as Record<string, string>), ...env },
          }),
        );
      } else {
        continue;
      }
      connected.push({ name: server.name, client: client as unknown as ToolClient });
      log("mcp_connected", { server: server.name });
    } catch (cause) {
      log("mcp_connect_failed", { server: server.name, error: String(cause) });
    }
  }
  return connected;
};

const findTool = async (
  clients: ReadonlyArray<{ name: string; client: ToolClient }>,
  wanted: string,
) => {
  for (const { name, client } of clients) {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === wanted || t.name.endsWith(`__${wanted}`));
    if (tool) return { server: name, client, toolName: tool.name };
  }
  return undefined;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const sessions = new Map<string, SessionState>();
let sessionCounter = 0;

const register = (
  id: string,
  cwd: string,
  mcpServers: ReadonlyArray<unknown> | undefined,
  event: string,
) => {
  const state: SessionState = {
    id,
    cwd,
    mcpServers: (mcpServers ?? []) as ReadonlyArray<McpServerConfig>,
    modelId: "default",
  };
  sessions.set(id, state);
  log(event, {
    sessionId: id,
    cwd,
    mcpServers: state.mcpServers.map((s) => ({ name: s.name, kind: s.url ? "http" : "stdio" })),
  });
  return state;
};

const isInactiveTurn = (result: unknown) =>
  Boolean((result as { isError?: boolean } | undefined)?.isError) &&
  JSON.stringify(result).includes("caller_turn_inactive");

/** The gateway accepts tool calls only once the turn is projected as running. */
const callWithRetry = async (client: ToolClient, name: string, args: Record<string, unknown>) => {
  let result: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    result = await client.callTool({ name, arguments: args });
    if (!isInactiveTurn(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return result;
};

const toWeb = () => ({
  output: Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  input: Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
});

export function startFakeAgent(options: {
  readonly agentName: string;
  readonly initializeExtras?: Record<string, unknown>;
}) {
  log("process_start", { argv: process.argv.slice(2) });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      log("process_signal", { signal });
      process.exit(0);
    });
  }
  process.stdin.on("end", () => log("stdin_closed", {}));
  const { output, input } = toWeb();
  new AgentSideConnection(
    (connection) => ({
      async initialize(params) {
        log("initialize", { protocolVersion: params.protocolVersion });
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: false },
          },
          authMethods: [{ id: "cached_token", name: "Cached token", description: null }],
          agentInfo: { name: options.agentName, version: "0.0.1" },
          ...options.initializeExtras,
        } as never;
      },
      async authenticate() {
        return {};
      },
      async newSession(params) {
        sessionCounter += 1;
        const id = `fake-${process.pid}-${sessionCounter}`;
        register(id, params.cwd, params.mcpServers, "session_new");
        return { sessionId: id } as never;
      },
      async loadSession(params) {
        register(params.sessionId, params.cwd, params.mcpServers, "session_load");
        return {} as never;
      },
      async unstable_setSessionModel(params: { sessionId: string; modelId: string }) {
        const state = sessions.get(params.sessionId);
        if (state) state.modelId = params.modelId;
        return {};
      },
      async setSessionMode() {
        return {};
      },
      async cancel(params) {
        log("cancel", { sessionId: params.sessionId });
        sessions.get(params.sessionId)?.abort?.abort();
      },
      async prompt(params) {
        const state = sessions.get(params.sessionId);
        if (!state) throw new Error(`unknown session ${params.sessionId}`);
        const text = promptText(params.prompt as never);
        const abort = new AbortController();
        state.abort = abort;
        const { rule, steps, match } = pickSteps(readScript(), text, state.cwd);
        log("prompt", {
          sessionId: state.id,
          cwd: state.cwd,
          rule,
          length: text.length,
          // The whole prompt: a bot's "You are <name>" line comes first, and the roster after it
          // grows with every bot, so a clipped prompt would hide whose turn it is.
          text,
        });
        log("rule", { sessionId: state.id, rule });
        const scope: Record<string, unknown> = { prompt: text, cwd: state.cwd, match, saved: {} };
        const update = (update: unknown) =>
          connection.sessionUpdate({ sessionId: state.id, update: update as never });

        let toolCounter = 0;
        for (const raw of steps) {
          if (abort.signal.aborted) return { stopReason: "cancelled" };
          const step = template(raw, scope) as Step;
          log("step", {
            sessionId: state.id,
            step: Object.keys(step)[0],
            say: "say" in step ? step.say : undefined,
          });
          if ("say" in step) {
            await update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: step.say },
            });
          } else if ("think" in step) {
            await update({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: step.think },
            });
          } else if ("sleepMs" in step) {
            await sleep(step.sleepMs, abort.signal);
          } else if ("stop" in step) {
            return { stopReason: step.stop };
          } else if ("error" in step) {
            log("scripted_error", { sessionId: state.id, message: step.error });
            throw new Error(step.error);
          } else if ("tool" in step) {
            toolCounter += 1;
            const toolCallId = `${state.id}-tool-${Date.now()}-${toolCounter}`;
            state.clients ??= connectMcp(state.mcpServers);
            const clients = await state.clients;
            const offered = await findTool(clients, step.tool);
            const gateway = clients.find((c) => c.name.toLowerCase().includes("synara"));
            const found =
              offered ??
              (step.force && gateway
                ? { server: gateway.name, client: gateway.client, toolName: step.tool }
                : undefined);
            await update({
              sessionUpdate: "tool_call",
              toolCallId,
              title: step.tool,
              kind: "other",
              status: "in_progress",
              rawInput: step.args ?? {},
            });
            if (!found) {
              log("tool_missing", {
                sessionId: state.id,
                tool: step.tool,
                servers: clients.map((c) => c.name),
              });
              await update({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "failed",
                content: [
                  {
                    type: "content",
                    content: { type: "text", text: `tool ${step.tool} not offered` },
                  },
                ],
              });
              continue;
            }
            log("tool", {
              sessionId: state.id,
              tool: found.toolName,
              args: step.args ?? {},
              ...(offered ? {} : { forced: true }),
            });
            let result: unknown;
            let failed = false;
            try {
              result = await callWithRetry(
                found.client,
                found.toolName,
                (step.args ?? {}) as Record<string, unknown>,
              );
              failed = Boolean((result as { isError?: boolean }).isError);
            } catch (cause) {
              failed = true;
              result = { error: String(cause) };
            }
            const structured =
              (result as { structuredContent?: unknown }).structuredContent ??
              (() => {
                const first = (result as { content?: Array<{ type: string; text?: string }> })
                  .content?.[0];
                if (first?.type === "text" && first.text) {
                  try {
                    return JSON.parse(first.text);
                  } catch {
                    return first.text;
                  }
                }
                return result;
              })();
            log("tool_result", {
              sessionId: state.id,
              tool: found.toolName,
              failed,
              result: structured,
            });
            if (step.saveAs) (scope.saved as Record<string, unknown>)[step.saveAs] = structured;
            await update({
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: failed ? "failed" : "completed",
              rawOutput: structured,
            });
          }
        }
        return { stopReason: "end_turn" };
      },
    }),
    ndJsonStream(output, input),
  );
}
