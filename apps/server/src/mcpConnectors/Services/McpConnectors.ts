/**
 * McpConnectors - Connectors: remote MCP servers the user signs in to
 * from Settings. Holds their tokens, and proxies provider sessions to them
 * through the agent gateway.
 *
 * @module mcpConnectors/Services/McpConnectors
 */
import type {
  McpConnector,
  McpConnectorConnectInput,
  McpConnectorConnectResult,
  McpConnectorSetup,
} from "@synara/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { McpConnectorProxyResult } from "../proxy.ts";
import type { McpConnectorCallbackOutcome, McpConnectorForwardRequest } from "../runtime.ts";

export class McpConnectorError extends Data.TaggedError("McpConnectorError")<{
  /** Written for the person connecting; safe to show in the UI. */
  readonly message: string;
  /** Machine-readable reason, e.g. MCP_CONNECTOR_CLIENT_REQUIRED_ERROR_CODE. */
  readonly code?: string;
  readonly cause?: unknown;
}> {}

export interface McpConnectorsShape {
  /** False on Stable: every method refuses and the routes answer 404. */
  readonly enabled: boolean;
  readonly list: () => Effect.Effect<ReadonlyArray<McpConnector>, McpConnectorError>;
  readonly connect: (
    input: McpConnectorConnectInput,
  ) => Effect.Effect<McpConnectorConnectResult, McpConnectorError>;
  readonly disconnect: (connectorId: string) => Effect.Effect<boolean, McpConnectorError>;
  /** What a user's own OAuth app needs, such as its redirect URL. */
  readonly setup: () => Effect.Effect<McpConnectorSetup, McpConnectorError>;
  /** The OAuth redirect target; never fails, the outcome is rendered as a page. */
  readonly completeAuthorization: (query: {
    readonly state: string | undefined;
    readonly code: string | undefined;
    readonly error: string | undefined;
    readonly errorDescription: string | undefined;
  }) => Effect.Effect<McpConnectorCallbackOutcome>;
  /** Proxies one MCP exchange; failures come back as JSON-RPC errors. */
  readonly forward: (
    connectorId: string,
    request: McpConnectorForwardRequest,
  ) => Effect.Effect<McpConnectorProxyResult>;
}

export class McpConnectors extends ServiceMap.Service<McpConnectors, McpConnectorsShape>()(
  "synara/mcpConnectors/Services/McpConnectors",
) {}
