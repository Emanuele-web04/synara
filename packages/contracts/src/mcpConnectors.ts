import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

// Connectors: remote and local MCP servers approved in Settings or chat.
// Synara owns credentials, process configuration, and provider-session proxies.

export const McpConnectorId = TrimmedNonEmptyString;
export type McpConnectorId = typeof McpConnectorId.Type;

/** "oauth" servers carry Synara-held tokens; "none" servers answer anonymously. */
export const McpConnectorAuthKind = Schema.Literals(["oauth", "none"]);
export type McpConnectorAuthKind = typeof McpConnectorAuthKind.Type;

/** "needs-auth": the refresh token stopped working; reconnecting signs in again. */
export const McpConnectorStatus = Schema.Literals(["connected", "unreachable", "needs-auth"]);
export type McpConnectorStatus = typeof McpConnectorStatus.Type;

const McpConnectorFields = {
  connectorId: McpConnectorId,
  /** Catalog key, or null for a custom URL. */
  presetId: Schema.NullOr(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  /** MCP server name provider sessions see, e.g. `supabase_connector`. */
  serverName: TrimmedNonEmptyString,
  authKind: McpConnectorAuthKind,
  /** Non-secret setup hint so reconnect can display the current redirect URL. */
  usesOwnOAuthApp: Schema.optional(Schema.Boolean),
  status: McpConnectorStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

const StdioFields = {
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(8192))).check(Schema.isMaxLength(128)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
};

/** Private connection configuration. Environment values belong only in the secret store. */
export const McpConnectorTransport = Schema.Union([
  Schema.Struct({ transport: Schema.Literal("remote-http"), url: TrimmedNonEmptyString }),
  Schema.Struct({ transport: Schema.Literal("local-http"), url: TrimmedNonEmptyString }),
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    ...StdioFields,
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
]);
export type McpConnectorTransport = typeof McpConnectorTransport.Type;

/** Public records never contain OAuth credentials or environment values. */
export const McpConnector = Schema.Union([
  Schema.Struct({
    ...McpConnectorFields,
    // Older hosts omit transport for remote HTTP connectors.
    transport: Schema.optional(Schema.Literals(["remote-http", "local-http"])),
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...McpConnectorFields,
    transport: Schema.Literal("stdio"),
    ...StdioFields,
    envKeys: Schema.Array(Schema.String),
  }),
]);
export type McpConnector = typeof McpConnector.Type;

/**
 * Exactly one of `presetId` or `url`; `name` only labels a custom URL.
 * `clientId`/`clientSecret` are the user's own OAuth app, for servers that do
 * not register clients themselves (Slack, Google).
 */
const HttpConnectFields = {
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
  clientId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  clientSecret: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
};
export const McpConnectorConnectInput = Schema.Union([
  Schema.Struct({
    ...HttpConnectFields,
    presetId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    ...HttpConnectFields,
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
    ...StdioFields,
    env: Schema.optional(
      Schema.Record(
        Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
        Schema.String.check(Schema.isMaxLength(32768)),
      ),
    ),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
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

/** Pending proposals are inert. Only the owner UI RPC can resolve them. */
export const McpConnectorProposal = Schema.Struct({
  proposalId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  action: Schema.Literals(["add", "remove"]),
  state: Schema.Literals(["pending", "accepted", "dismissed"]),
  connector: McpConnector,
  source: Schema.optional(Schema.String),
});
export type McpConnectorProposal = typeof McpConnectorProposal.Type;

export const McpConnectorResolveProposalInput = Schema.Struct({
  proposalId: TrimmedNonEmptyString,
  resolution: Schema.Literals(["accepted", "dismissed"]),
});
export type McpConnectorResolveProposalInput = typeof McpConnectorResolveProposalInput.Type;

export const McpConnectorResolveProposalResult = Schema.Struct({
  proposal: McpConnectorProposal,
  authorizationUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type McpConnectorResolveProposalResult = typeof McpConnectorResolveProposalResult.Type;
