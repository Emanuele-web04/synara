/**
 * Provider-facing config builders for the Synara agent gateway.
 *
 * One shared module shapes the same MCP connection (endpoint URL + per-thread
 * bearer token) into every provider's native MCP configuration format so the
 * injection rules cannot drift between adapters:
 *
 * - Codex: `[mcp_servers.synara]` TOML block (streamable HTTP +
 *   `bearer_token_env_var` resolved from the per-session process env).
 * - Claude Agent SDK: `mcpServers` record with an HTTP entry.
 * - ACP agents (cursor/grok/droid): `mcpServers` session entries; HTTP when
 *   the agent advertises `mcpCapabilities.http`, otherwise a stdio proxy that
 *   forwards to the HTTP endpoint.
 *
 * @module agentGateway/mcpInjection
 */
import type * as Acp from "@agentclientprotocol/sdk";

import type {
  AgentGatewayMcpConnection,
  AgentGatewayStdioProxySpawn,
} from "./Services/AgentGatewayCredentials.ts";

export const SYNARA_MCP_SERVER_NAME = "synara";
export const SYNARA_AGENT_GATEWAY_TOKEN_ENV = "SYNARA_AGENT_GATEWAY_TOKEN";
export const SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV = "SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN";
export const SYNARA_AGENT_GATEWAY_URL_ENV = "SYNARA_AGENT_GATEWAY_URL";

function authorizationHeader(connection: AgentGatewayMcpConnection): string {
  return `Bearer ${connection.bearerToken}`;
}

/**
 * Codex reads MCP servers from `config.toml`; the config file is shared by all
 * sessions of one Codex home, so the token is never written into it. Instead
 * the block references an env var that Synara sets per app-server process.
 *
 * The shell_environment_policy table keeps that env var out of exec tool
 * subprocesses: codex defaults to `ignore_default_excludes = true`, so the
 * built-in *TOKEN* filter is inactive and workspace commands would otherwise
 * inherit the gateway bearer token. Appended per-table, so a user-defined
 * policy table is never duplicated (their policy then governs).
 */
export function buildCodexMcpConfigToml(endpointUrl: string): string {
  return [
    `[mcp_servers.${SYNARA_MCP_SERVER_NAME}]`,
    `url = ${JSON.stringify(endpointUrl)}`,
    `bearer_token_env_var = ${JSON.stringify(SYNARA_AGENT_GATEWAY_TOKEN_ENV)}`,
    "",
    "[shell_environment_policy]",
    `exclude = [${JSON.stringify(SYNARA_AGENT_GATEWAY_TOKEN_ENV)}]`,
  ].join("\n");
}

export interface ClaudeMcpHttpServerConfig {
  readonly type: "http";
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface OpenCodeMcpRemoteServerConfig {
  readonly type: "remote";
  readonly url: string;
  readonly enabled: true;
  readonly headers: Record<string, string>;
  readonly oauth: false;
}

/**
 * OpenCode's dynamic `mcp.add` endpoint is server/directory scoped rather
 * than session scoped. Callers must install this config through either a
 * provider process dedicated to the owning Synara thread or an exclusive
 * external-server/directory lock held for the full agent turn.
 */
export function buildOpenCodeMcpServer(
  connection: AgentGatewayMcpConnection,
): OpenCodeMcpRemoteServerConfig {
  return {
    type: "remote",
    url: connection.url,
    enabled: true,
    headers: { Authorization: authorizationHeader(connection) },
    oauth: false,
  };
}

export interface AgentGatewayMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export type AgentGatewayMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function postAgentGatewayJsonRpc(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly fetch?: AgentGatewayMcpFetch;
}): Promise<unknown> {
  const id = globalThis.crypto.randomUUID();
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const response = await fetchImpl(input.connection.url, {
    method: "POST",
    headers: {
      Authorization: authorizationHeader(input.connection),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: input.method,
      ...(input.params === undefined ? {} : { params: input.params }),
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    throw new Error(`Synara MCP request failed with HTTP ${String(response.status)}.`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
    throw new Error("Synara MCP returned an invalid JSON-RPC response.");
  }
  if ("error" in payload) {
    const failure = isRecord(payload.error) ? payload.error : null;
    throw new Error(failure?.message ? String(failure.message) : "Synara MCP request failed.");
  }
  if (payload.id !== id || !("result" in payload)) {
    throw new Error("Synara MCP returned a mismatched JSON-RPC response.");
  }
  return payload.result;
}

/** Load the canonical gateway tool descriptors for native-tool providers. */
export async function listAgentGatewayMcpTools(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly fetch?: AgentGatewayMcpFetch;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<AgentGatewayMcpToolDescriptor>> {
  const result = await postAgentGatewayJsonRpc({
    ...input,
    method: "tools/list",
  });
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new Error("Synara MCP tools/list returned an invalid tool catalog.");
  }
  return result.tools.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      typeof value.description !== "string" ||
      !isRecord(value.inputSchema)
    ) {
      throw new Error("Synara MCP tools/list returned an invalid tool descriptor.");
    }
    return {
      name: value.name,
      description: value.description,
      inputSchema: value.inputSchema,
    };
  });
}

/** Invoke the canonical gateway dispatcher through its authenticated MCP route. */
export function callAgentGatewayMcpTool(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly fetch?: AgentGatewayMcpFetch;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  return postAgentGatewayJsonRpc({
    connection: input.connection,
    method: "tools/call",
    params: { name: input.name, arguments: input.arguments },
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export function buildClaudeMcpServers(
  connection: AgentGatewayMcpConnection,
): Record<string, ClaudeMcpHttpServerConfig> {
  return {
    [SYNARA_MCP_SERVER_NAME]: {
      type: "http",
      url: connection.url,
      headers: { Authorization: authorizationHeader(connection) },
    },
  };
}

export type AcpStdioProxySpawn = AgentGatewayStdioProxySpawn;

export interface AntigravityMcpPluginConfig {
  readonly mcpServers: Record<
    string,
    {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Record<string, string>;
      readonly disabled: false;
      readonly disabledTools: ReadonlyArray<string>;
    }
  >;
}

/**
 * Build the secret-free MCP fragment installed with Synara's Antigravity
 * plugin. Antigravity expands the endpoint plus a one-shot bootstrap value
 * from each `agy` process. The stdio proxy consumes that value during MCP
 * initialization and keeps the exchanged session bearer in its own memory,
 * so `run_command` descendants never inherit the bearer.
 *
 * `ELECTRON_RUN_AS_NODE` keeps the generated proxy runnable when a packaged
 * desktop uses its Electron executable as `process.execPath`; it is harmless
 * for regular Node and Bun executables.
 */
export function buildAntigravityMcpPluginConfig(
  stdioProxy: AcpStdioProxySpawn,
): AntigravityMcpPluginConfig {
  return {
    mcpServers: {
      [SYNARA_MCP_SERVER_NAME]: {
        command: stdioProxy.command,
        args: [...stdioProxy.args],
        env: {
          [SYNARA_AGENT_GATEWAY_URL_ENV]: `$${SYNARA_AGENT_GATEWAY_URL_ENV}`,
          [SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV]: `$${SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV}`,
          ELECTRON_RUN_AS_NODE: "1",
        },
        disabled: false,
        disabledTools: [],
      },
    },
  };
}

// Structural view of an ACP initialize response so callers with untyped
// (raw JSON) responses can reuse the same transport negotiation.
export interface AcpInitializeCapabilitiesView {
  readonly agentCapabilities?: {
    readonly mcpCapabilities?: {
      readonly http?: boolean;
    };
  } | null;
}

/**
 * Build the `mcpServers` entries for an ACP `session/new` / `session/load`
 * payload. Prefers the HTTP transport when the agent advertises support and
 * falls back to the stdio->HTTP proxy script otherwise (stdio is the ACP
 * baseline every agent must accept).
 */
export function buildAcpSynaraMcpServers(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly initializeResult: AcpInitializeCapabilitiesView;
  readonly stdioProxy: AcpStdioProxySpawn;
}): Array<Acp.McpServer> {
  const supportsHttp = input.initializeResult.agentCapabilities?.mcpCapabilities?.http === true;
  if (supportsHttp) {
    return [
      {
        type: "http",
        name: SYNARA_MCP_SERVER_NAME,
        url: input.connection.url,
        headers: [{ name: "Authorization", value: authorizationHeader(input.connection) }],
      },
    ];
  }
  return [
    {
      name: SYNARA_MCP_SERVER_NAME,
      command: input.stdioProxy.command,
      args: [...input.stdioProxy.args],
      env: [
        { name: SYNARA_AGENT_GATEWAY_URL_ENV, value: input.connection.url },
        { name: SYNARA_AGENT_GATEWAY_TOKEN_ENV, value: input.connection.bearerToken },
      ],
    },
  ];
}
