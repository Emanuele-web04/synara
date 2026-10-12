// FILE: agentGateway/usageTools.ts
// Purpose: Expose cached, normalized provider quota through account-addressable read-only MCP tools.
// Fetching and quota interpretation stay in providerUsage; gateway code only applies authority.

import type { ServerAgentProviderAccountUsage } from "@synara/contracts";
import { Effect } from "effect";

import { PROVIDER_ACCOUNT_USAGE_INPUT_SCHEMA } from "../providerUsage/agentReader.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { errorText } from "./toolInput.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

export interface AgentGatewayUsageToolsInput {
  readonly loadProviderUsage: (
    query?: unknown,
  ) => Effect.Effect<ReadonlyArray<ServerAgentProviderAccountUsage>, unknown, never>;
}

export function makeAgentGatewayUsageTools(
  input: AgentGatewayUsageToolsInput,
): ReadonlyArray<ToolEntry> {
  const handler: ToolEntry["handler"] = (args) =>
    input.loadProviderUsage(args).pipe(
      Effect.map((usage) => mcpToolResultJson({ usage })),
      Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
    );
  const getUsage: ToolEntry = {
    requiredCapability: "usage:read",
    definition: {
      name: "synara_get_usage",
      description:
        "Read cached quota for every configured provider account, or filter by provider and instanceId. This does not refresh providers: missing, stale, disabled, and unsupported accounts remain explicit. Only fresh authoritative quota windows have actionable remaining percentages; token and spend lines are informational.",
      inputSchema: PROVIDER_ACCOUNT_USAGE_INPUT_SCHEMA,
      annotations: { title: "Get provider usage", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler,
  };

  const listUsage: ToolEntry = {
    requiredCapability: "usage:read",
    definition: {
      name: "synara_list_provider_usage",
      description:
        "Alias for synara_get_usage: list cached quota for every configured account, optionally filtered by provider and instanceId. Each account retains its identity, freshness, and explicit unavailable state.",
      inputSchema: PROVIDER_ACCOUNT_USAGE_INPUT_SCHEMA,
      annotations: { title: "List provider usage", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler,
  };

  return [getUsage, listUsage];
}
