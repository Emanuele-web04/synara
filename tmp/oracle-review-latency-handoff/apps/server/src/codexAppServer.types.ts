// Purpose: Shared type definitions for the Codex app-server integration —
//   JSON-RPC message shapes, pending-request/approval/user-input records, session
//   context, account/plan snapshots, runtime override shapes, and the public
//   manager input/output contracts.
// Layer: Type-only. No runtime values. Safe to import from anywhere without cycles.
// Exports: see individual `export` declarations below.
import type {
  ApprovalRequestId,
  ProviderApprovalPolicy,
  ProviderEvent,
  ProviderItemId,
  ProviderListPluginsInput,
  ProviderMentionReference,
  ProviderReadPluginInput,
  ProviderRequestKind,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSandboxMode,
  ProviderSkillReference,
  ProviderStartReviewInput,
  ProviderThreadInjectTextItem,
  RuntimeMode,
  ProviderInteractionMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import type { JsonRpcLineTransport } from "./provider/process/JsonRpcLineTransport.ts";

export type PendingRequestKey = string;

export interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval";
  requestKind: ProviderRequestKind;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

export interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

export interface CodexUserInputAnswer {
  answers: string[];
}

export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexTurnSandboxPolicy = {
  readonly type: "readOnly" | "workspaceWrite" | "dangerFullAccess";
};
export type CodexSessionApprovalOverride = {
  readonly approvalPolicy: "never";
  readonly sandboxPolicy: {
    readonly type: "dangerFullAccess";
  };
};

export interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  transport: JsonRpcLineTransport;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  sessionApprovalOverride?: CodexSessionApprovalOverride;
  collabReceiverTurns: Map<string, TurnId>;
  collabReceiverParents: Map<string, string>;
  reviewTurnIds: Set<TurnId>;
  nextRequestId: number;
  stopping: boolean;
  discovery?: boolean;
}

export interface CodexSkillListInput {
  readonly cwd: string;
  readonly forceReload?: boolean;
  readonly threadId?: string;
}

export interface CodexPluginListInput extends Omit<ProviderListPluginsInput, "provider"> {}

export interface CodexPluginReadInput extends Omit<ProviderReadPluginInput, "provider"> {}

export interface JsonRpcError {
  code?: number;
  message?: string;
}

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

export interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

export interface CodexVoiceTranscriptionAuthContext {
  readonly authMethod: "chatgpt" | "chatgptAuthTokens";
  readonly token: string;
}

export interface CodexStartupDiscovery {
  readonly advertisedModelSlugs: ReadonlyArray<string>;
  readonly account: CodexAccountSnapshot;
}

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
  readonly mentions?: ReadonlyArray<ProviderMentionReference>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexAppServerInjectThreadItemsInput {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<ProviderThreadInjectTextItem>;
}

export type CodexAppServerReviewTarget = ProviderStartReviewInput["target"];

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly approvalPolicy?: ProviderApprovalPolicy;
  readonly sandboxMode?: ProviderSandboxMode;
  readonly reviewProfile?: "review-chat";
  readonly runtimeMode: RuntimeMode;
  readonly effort?: string;
  /**
   * Per-session transport override for a sandbox-backed thread: starts
   * `codex app-server` inside the provisioned remote instance and returns its
   * line transport. Takes precedence over the constructor-level factory. When
   * absent the manager spawns a local codex process (the default).
   */
  readonly createTransport?: CodexTransportFactory;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
  cwd?: string | null;
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export interface CodexTransportFactoryInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}

export type CodexTransportFactory = (
  input: CodexTransportFactoryInput,
) => Promise<JsonRpcLineTransport>;

export interface CodexAppServerManagerOptions {
  /**
   * Overrides the process-spawning transport with a supplied
   * `JsonRpcLineTransport`. Used by tests to drive the Codex protocol against a
   * scripted in-memory transport, and reserved for the remote runtime path.
   */
  readonly createTransport?: CodexTransportFactory;
}
