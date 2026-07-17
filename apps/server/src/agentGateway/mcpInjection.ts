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
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AgentGatewayMcpConnection } from "./Services/AgentGatewayCredentials";

export const SYNARA_MCP_SERVER_NAME = "synara";
export const SYNARA_AGENT_GATEWAY_TOKEN_ENV = "SYNARA_AGENT_GATEWAY_TOKEN";
export const SYNARA_AGENT_GATEWAY_URL_ENV = "SYNARA_AGENT_GATEWAY_URL";

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

export function buildClaudeMcpServers(
  connection: AgentGatewayMcpConnection,
): Record<string, ClaudeMcpHttpServerConfig> {
  return {
    [SYNARA_MCP_SERVER_NAME]: {
      type: "http",
      url: connection.url,
      headers: { Authorization: `Bearer ${connection.bearerToken}` },
    },
  };
}

export interface AcpStdioProxySpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

// Structural view of an ACP initialize response so callers with untyped
// (raw JSON) responses can reuse the same transport negotiation.
export interface AcpInitializeCapabilitiesView {
  readonly agentCapabilities?:
    | {
        readonly mcpCapabilities?:
          | {
              readonly http?: boolean | undefined;
            }
          | undefined;
      }
    | undefined
    | null;
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
}): ReadonlyArray<EffectAcpSchema.McpServer> {
  const supportsHttp = input.initializeResult.agentCapabilities?.mcpCapabilities?.http === true;
  if (supportsHttp) {
    return [
      {
        type: "http",
        name: SYNARA_MCP_SERVER_NAME,
        url: input.connection.url,
        headers: [{ name: "Authorization", value: `Bearer ${input.connection.bearerToken}` }],
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
