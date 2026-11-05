import type { McpConnectorProposal } from "@synara/contracts";
import { MCP_CONNECTOR_PROVIDER_IDS } from "@synara/shared/mcpConnectors";
import { Effect } from "effect";
import {
  McpConnectorError,
  type McpConnectorsShape,
} from "../mcpConnectors/Services/McpConnectors.ts";
import { importMcpServerCandidates } from "../mcpConnectors/importServers.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

const availability =
  "Available in new threads after approval. Existing threads keep their current connector set.";
const proposalResult = (proposal: McpConnectorProposal) => ({
  proposalId: proposal.proposalId,
  name: proposal.connector.name,
  transport: proposal.connector.transport,
  action: proposal.action,
  state: proposal.state,
  message: `Review the approval card in Synara. ${availability}`,
});

export function makeConnectorTools(deps: {
  readonly connectors: McpConnectorsShape;
  readonly resolveWorkspaceRoot: (context: ToolContext) => Effect.Effect<string | null>;
  readonly surface: (proposal: McpConnectorProposal) => Effect.Effect<void, unknown>;
}): readonly ToolEntry[] {
  if (!deps.connectors.enabled) return [];
  const guarded =
    (
      handler: (
        args: Record<string, unknown>,
        context: ToolContext,
      ) => Effect.Effect<unknown, unknown>,
    ): ToolEntry["handler"] =>
    (args, context) =>
      context.remoteCaller
        ? Effect.succeed(
            mcpToolResultError("Manage connectors from a chat on the owning computer."),
          )
        : handler(args, context).pipe(
            Effect.map(mcpToolResultJson),
            Effect.catch((error) =>
              Effect.succeed(
                mcpToolResultError(
                  error instanceof McpConnectorError
                    ? error.message
                    : "Could not prepare this connector request. Check its settings; no connector was approved by this tool.",
                ),
              ),
            ),
          );
  const surface = (proposal: McpConnectorProposal) =>
    deps.surface(proposal).pipe(Effect.as(proposalResult(proposal)));
  return [
    {
      requiredCapability: "thread:read",
      definition: {
        name: "synara_list_mcp_connectors",
        description:
          "List saved connectors, status, transport and supported providers. URL credentials and process environment values are never returned. " +
          availability,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      handler: guarded(() =>
        deps.connectors.list().pipe(
          Effect.map((connectors) => ({
            connectors: connectors.map((connector) => ({
              connectorId: connector.connectorId,
              name: connector.name,
              transport: connector.transport ?? "remote-http",
              status: connector.status,
              ...(connector.transport === "stdio"
                ? { command: connector.command }
                : { url: new URL(connector.url).origin, urlPathHidden: true }),
              providers: MCP_CONNECTOR_PROVIDER_IDS,
            })),
            message: availability,
          })),
        ),
      ),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_add_mcp_connector",
        description:
          "Propose adding an MCP connector. Always requires the user's approval card, including HTTP and presets. Never executes a command or connects before approval. Pass command and args separately, not a shell string. Never include secrets in chat; the user can enter environment values in Settings. OAuth opens only after approval. " +
          availability,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            url: { type: "string" },
            presetId: { type: "string" },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            env: { type: "object", additionalProperties: { type: "string" } },
            cwd: { type: "string" },
          },
          additionalProperties: false,
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: guarded((args, context) =>
        Effect.gen(function* () {
          const cwd = yield* deps.resolveWorkspaceRoot(context);
          const proposal = yield* deps.connectors.proposeAdd(
            args,
            context.callerThreadId,
            cwd ?? undefined,
          );
          return yield* surface(proposal);
        }),
      ),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_remove_mcp_connector",
        description:
          "Propose removing a connector. Removal happens only when the user accepts the confirmation card.",
        inputSchema: {
          type: "object",
          properties: { connectorId: { type: "string" } },
          required: ["connectorId"],
          additionalProperties: false,
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: guarded((args, context) =>
        Effect.gen(function* () {
          if (typeof args.connectorId !== "string") throw new Error("Connector ID required.");
          return yield* surface(
            yield* deps.connectors.proposeRemove(args.connectorId, context.callerThreadId),
          );
        }),
      ),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "synara_import_mcp_servers",
        description:
          "Discover MCP servers in Claude Code user/current project config, Codex, workspace .mcp.json and Claude Desktop. Shows a separate approval card for each candidate. Only entries the user accepts are added. Never returns environment values or runs discovered commands.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: guarded((_args, context) =>
        Effect.gen(function* () {
          const cwd = yield* deps.resolveWorkspaceRoot(context);
          const found = yield* Effect.tryPromise(() => importMcpServerCandidates(cwd));
          const proposals = [];
          for (const candidate of found.candidates) {
            const proposal = yield* deps.connectors.proposeAdd(
              candidate.input,
              context.callerThreadId,
              cwd ?? undefined,
              candidate.source,
            );
            proposals.push(yield* surface(proposal));
          }
          return {
            proposals,
            warnings: found.warnings,
            message: "Accept only the connectors you want in the approval cards.",
          };
        }),
      ),
    },
  ];
}
