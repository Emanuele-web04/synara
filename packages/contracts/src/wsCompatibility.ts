import { Schema } from "effect";

import { NonNegativeInt } from "./baseSchemas";

export const WS_PROTOCOL_EPOCH = 1;
// Revision 2 changes PullRequestCommit.authors to permit name-only authors.
// Revision 3 replaces pullRequests.list and pullRequests.reviewRequestCount with
// githubInbox.list and adds the "rate-limited" PullRequestsUnavailableError reason.
// Keep older revisions out of the compatibility range: a revision-2 client would
// call methods this server no longer serves and could not decode the new error.
export const WS_PROTOCOL_MIN_REVISION = 3;
export const WS_PROTOCOL_MAX_REVISION = 3;
export const WS_BOOTSTRAP_METHOD = "bootstrap.negotiate";
export const WS_BOOTSTRAP_PATH = "/ws/bootstrap";
export const WS_NEGOTIATE_HTTP_PATH = "/ws/negotiate";
export const WS_FEATURE_PATH = "/ws";

// protocol budgets shared by both sides — prevents prewarming subscriptions the connection can never admit
export const WS_STREAM_LIMITS = {
  totalPerClient: 20,
  threadPerClient: 8,
} as const;

export const WS_COMPATIBILITY_QUERY = {
  clientBuild: "x-synara-client-build",
  protocolEpoch: "x-synara-protocol-epoch",
  protocolRevision: "x-synara-protocol-revision",
  serverInstanceId: "x-synara-server-instance",
} as const;

export const WS_NEGOTIATE_QUERY = {
  clientBuild: "x-synara-client-build",
  protocolEpoch: "x-synara-protocol-epoch",
  minRevision: "x-synara-protocol-min-revision",
  maxRevision: "x-synara-protocol-max-revision",
  requiredCapability: "x-synara-required-capability",
} as const;

export const WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY = "projects.github-provisioning";
export const WS_PROJECT_FILE_WATCH_CAPABILITY = "projects.file-watch";
export const WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY = "orchestration.turn-dispatch-settlement";
export const WS_SERVER_RUNTIME_STATUS_CAPABILITY = "server.runtime-status";
export const WS_GIT_ACTION_RECOVERY_CAPABILITY = "git.action-recovery";

// kept separate from the advertised list so a newer client can still negotiate with an older server during rollout
export const WS_CLIENT_REQUIRED_CAPABILITIES = [
  "orchestration.cursor-safe-streams",
  "orchestration.thread-detail-snapshot",
  "rpc.typed-errors",
  // an older server would answer it unary and the setup card would never advance — fail negotiation with a clear "update-server" instead
  "git.worktree-setup-progress",
] as const;

export const WS_SERVER_CAPABILITIES = [
  ...WS_CLIENT_REQUIRED_CAPABILITIES,
  // older servers may omit it without breaking a newer client during staggered rollout
  WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  WS_TURN_DISPATCH_SETTLEMENT_CAPABILITY,
  WS_GIT_ACTION_RECOVERY_CAPABILITY,
  WS_SERVER_RUNTIME_STATUS_CAPABILITY,
  // Single-handshake connect: negotiation is available over plain HTTP at
  // WS_NEGOTIATE_HTTP_PATH, so a connect costs exactly one WebSocket upgrade.
  "transport.http-negotiate",
] as const;

export const WsCompatibilityAction = Schema.Literals(["reload", "update-client", "update-server"]);
export type WsCompatibilityAction = typeof WsCompatibilityAction.Type;

export const WsBootstrapNegotiateInput = Schema.Struct({
  protocolEpoch: Schema.Int,
  minRevision: NonNegativeInt,
  maxRevision: NonNegativeInt,
  clientBuild: Schema.String,
  requiredCapabilities: Schema.Array(Schema.String),
});
export type WsBootstrapNegotiateInput = typeof WsBootstrapNegotiateInput.Type;

export const WsBootstrapNegotiateResult = Schema.Struct({
  protocolEpoch: Schema.Int,
  negotiatedRevision: NonNegativeInt,
  serverBuild: Schema.String,
  serverInstanceId: Schema.String,
  capabilities: Schema.Array(Schema.String),
});
export type WsBootstrapNegotiateResult = typeof WsBootstrapNegotiateResult.Type;

export class WsCompatibilityError extends Schema.TaggedErrorClass<WsCompatibilityError>()(
  "WsCompatibilityError",
  {
    message: Schema.String,
    code: Schema.Literals([
      "WS_PROTOCOL_INCOMPATIBLE",
      "WS_CAPABILITIES_INCOMPATIBLE",
      "WS_NEGOTIATION_REQUIRED",
      "WS_SERVER_GENERATION_CHANGED",
    ]),
    retryable: Schema.Literal(false),
    action: WsCompatibilityAction,
    serverBuild: Schema.String,
    protocolEpoch: Schema.Int,
    minRevision: NonNegativeInt,
    maxRevision: NonNegativeInt,
  },
) {}
