/** Agent delegation over an already paired execution connection. No bearer tokens cross hosts. */
import { Schema } from "effect";
import { EnvironmentId, ProjectId, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind, RuntimeMode } from "./orchestration";

export const REMOTE_AGENT_GATEWAY_CAPABILITY = "agent-gateway.remote-v1";
export const RemoteAgentCaller = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  provider: ProviderKind,
  runtimeMode: RuntimeMode,
  envMode: Schema.Literals(["local", "worktree"]),
  capabilities: Schema.Array(Schema.Literals(["thread:read", "thread:write", "diagnostics:read"])),
});
export type RemoteAgentCaller = typeof RemoteAgentCaller.Type;

export const RemoteAgentCall = Schema.Struct({
  environmentId: EnvironmentId,
  caller: RemoteAgentCaller,
  tool: TrimmedNonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Json),
});
export type RemoteAgentCall = typeof RemoteAgentCall.Type;

export const RemoteAgentResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});
export type RemoteAgentResult = typeof RemoteAgentResult.Type;

/** Remote caller policy has no local project or worktree path to inherit. */
export type RemoteAgentCallerPolicy = {
  readonly runtimeMode: typeof RuntimeMode.Type;
  readonly envMode: "local" | "worktree";
  readonly projectId?: ProjectId;
  readonly worktreePath?: string | null;
};
