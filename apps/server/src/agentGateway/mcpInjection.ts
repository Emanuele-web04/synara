/** shapes one MCP connection (endpoint + per-thread bearer) into each provider's native format so injection rules can't drift between adapters */
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

/** the token is never written into the shared config.toml — referenced via env var; shell_environment_policy keeps it out of exec subprocesses (codex's ignore_default_excludes=true disables the built-in *TOKEN* filter) */
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

/** mcp.add is server/directory scoped — callers must use a dedicated provider process or an exclusive directory lock for the turn */
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

/** canonical gateway tool descriptors for native-tool providers */
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

/** invoke the canonical dispatcher through the authenticated MCP route */
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

/** one-shot bootstrap exchange: the stdio proxy consumes it during MCP init so run_command descendants never inherit the bearer; ELECTRON_RUN_AS_NODE keeps the proxy runnable under a packaged desktop's execPath */
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

// structural view of an ACP initialize response so raw-JSON callers reuse the same negotiation
export interface AcpInitializeCapabilitiesView {
  readonly agentCapabilities?: {
    readonly mcpCapabilities?: {
      readonly http?: boolean;
    };
  } | null;
}

/** prefer HTTP when the agent advertises support, else the stdio→HTTP proxy (stdio is the ACP baseline every agent must accept) */
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
