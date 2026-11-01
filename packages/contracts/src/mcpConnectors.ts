import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

// Connectors (Beta): remote MCP servers the user signs in to from Settings.
// Synara keeps their OAuth tokens and proxies provider sessions to them.

export const McpConnectorId = TrimmedNonEmptyString;
export type McpConnectorId = typeof McpConnectorId.Type;

/** "oauth" servers carry Synara-held tokens; "none" servers answer anonymously. */
export const McpConnectorAuthKind = Schema.Literals(["oauth", "none"]);
export type McpConnectorAuthKind = typeof McpConnectorAuthKind.Type;

/** "needs-auth": the refresh token stopped working; reconnecting signs in again. */
export const McpConnectorStatus = Schema.Literals(["connected", "needs-auth"]);
export type McpConnectorStatus = typeof McpConnectorStatus.Type;

export const McpConnector = Schema.Struct({
  connectorId: McpConnectorId,
  /** Catalog key, or null for a custom URL. */
  presetId: Schema.NullOr(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  /** MCP server name provider sessions see, e.g. `supabase_connector`. */
  serverName: TrimmedNonEmptyString,
  authKind: McpConnectorAuthKind,
  /** Non-secret setup hint so reconnect can display the current redirect URL. */
  usesOwnOAuthApp: Schema.optional(Schema.Boolean),
  status: McpConnectorStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type McpConnector = typeof McpConnector.Type;

/**
 * Exactly one of `presetId` or `url`; `name` only labels a custom URL.
 * `clientId`/`clientSecret` are the user's own OAuth app, for servers that do
 * not register clients themselves (Slack, Google).
 */
export const McpConnectorConnectInput = Schema.Struct({
  presetId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
  clientId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  clientSecret: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type McpConnectorConnectInput = typeof McpConnectorConnectInput.Type;

/** Connect failed because the server needs the user's own OAuth app. */
export const MCP_CONNECTOR_CLIENT_REQUIRED_ERROR_CODE = "mcp-connector-client-required";

/** Where an OAuth app must send the user back, for its redirect URL setting. */
export const McpConnectorSetup = Schema.Struct({
  redirectUrl: TrimmedNonEmptyString,
});
export type McpConnectorSetup = typeof McpConnectorSetup.Type;

/**
 * `authorizationUrl` is set when the user must sign in: open it in the
 * browser; the connector appears in the list once the callback completes.
 * `connector` is set when the server needed no sign-in and is connected.
 */
export const McpConnectorConnectResult = Schema.Struct({
  authorizationUrl: Schema.NullOr(TrimmedNonEmptyString),
  connector: Schema.NullOr(McpConnector),
});
export type McpConnectorConnectResult = typeof McpConnectorConnectResult.Type;

export const McpConnectorDisconnectInput = Schema.Struct({
  connectorId: McpConnectorId,
});
export type McpConnectorDisconnectInput = typeof McpConnectorDisconnectInput.Type;

export const McpConnectorDisconnectResult = Schema.Struct({
  disconnected: Schema.Boolean,
});
export type McpConnectorDisconnectResult = typeof McpConnectorDisconnectResult.Type;
