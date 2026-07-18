import type {
  CompanionCreateThreadInput,
  CompanionGetThreadDiffInput,
  CompanionGetThreadDiffResult,
  CompanionGetThreadInput,
  CompanionGetThreadResult,
  CompanionGetTurnDiffInput,
  CompanionGetTurnDiffResult,
  CompanionHello,
  CompanionHelloInput,
  CompanionInterruptTurnInput,
  CompanionListComposerOptionsInput,
  CompanionListComposerOptionsResult,
  CompanionListProjectsInput,
  CompanionListProjectsResult,
  CompanionListThreadsInput,
  CompanionListThreadsResult,
  CompanionMutationReceipt,
  CompanionRespondToApprovalInput,
  CompanionRespondToUserInputInput,
  CompanionSendTurnInput,
  CompanionShellStreamItem,
  CompanionSubscribeShellInput,
  CompanionSubscribeThreadInput,
  CompanionThreadStreamItem,
} from "@synara/contracts";
import { COMPANION_RPC_METHODS } from "@synara/contracts";

export interface CompanionOperation<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

export type CompanionRequestMap = {
  [COMPANION_RPC_METHODS.hello]: CompanionOperation<CompanionHelloInput, CompanionHello>;
  [COMPANION_RPC_METHODS.listProjects]: CompanionOperation<
    CompanionListProjectsInput,
    CompanionListProjectsResult
  >;
  [COMPANION_RPC_METHODS.listThreads]: CompanionOperation<
    CompanionListThreadsInput,
    CompanionListThreadsResult
  >;
  [COMPANION_RPC_METHODS.getThread]: CompanionOperation<
    CompanionGetThreadInput,
    CompanionGetThreadResult
  >;
  [COMPANION_RPC_METHODS.listComposerOptions]: CompanionOperation<
    CompanionListComposerOptionsInput,
    CompanionListComposerOptionsResult
  >;
  [COMPANION_RPC_METHODS.createThread]: CompanionOperation<
    CompanionCreateThreadInput,
    CompanionMutationReceipt
  >;
  [COMPANION_RPC_METHODS.sendTurn]: CompanionOperation<
    CompanionSendTurnInput,
    CompanionMutationReceipt
  >;
  [COMPANION_RPC_METHODS.interruptTurn]: CompanionOperation<
    CompanionInterruptTurnInput,
    CompanionMutationReceipt
  >;
  [COMPANION_RPC_METHODS.respondToApproval]: CompanionOperation<
    CompanionRespondToApprovalInput,
    CompanionMutationReceipt
  >;
  [COMPANION_RPC_METHODS.respondToUserInput]: CompanionOperation<
    CompanionRespondToUserInputInput,
    CompanionMutationReceipt
  >;
  [COMPANION_RPC_METHODS.getTurnDiff]: CompanionOperation<
    CompanionGetTurnDiffInput,
    CompanionGetTurnDiffResult
  >;
  [COMPANION_RPC_METHODS.getThreadDiff]: CompanionOperation<
    CompanionGetThreadDiffInput,
    CompanionGetThreadDiffResult
  >;
};

export type CompanionStreamMap = {
  [COMPANION_RPC_METHODS.subscribeShell]: CompanionOperation<
    CompanionSubscribeShellInput,
    CompanionShellStreamItem
  >;
  [COMPANION_RPC_METHODS.subscribeThread]: CompanionOperation<
    CompanionSubscribeThreadInput,
    CompanionThreadStreamItem
  >;
};

export type CompanionRequestMethod = keyof CompanionRequestMap;
export type CompanionStreamMethod = keyof CompanionStreamMap;
export type CompanionRequestInput<Method extends CompanionRequestMethod> =
  CompanionRequestMap[Method]["input"];
export type CompanionRequestOutput<Method extends CompanionRequestMethod> =
  CompanionRequestMap[Method]["output"];
export type CompanionStreamInput<Method extends CompanionStreamMethod> =
  CompanionStreamMap[Method]["input"];
export type CompanionStreamItem<Method extends CompanionStreamMethod> =
  CompanionStreamMap[Method]["output"];

export interface CompanionTransportClose {
  readonly code?: number;
  readonly reason?: string;
  readonly clean: boolean;
}

export interface CompanionTransportSubscription {
  close(): Promise<void>;
}

export interface CompanionStreamHandlers<Item> {
  readonly onItem: (item: Item) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * A connected, schema-validating wire session.
 *
 * Implementations may use Effect RPC internally, but consumers of this package
 * only depend on this Promise-based boundary.
 */
export interface CompanionTransport {
  readonly closed: Promise<CompanionTransportClose>;
  request<Method extends CompanionRequestMethod>(
    method: Method,
    input: CompanionRequestInput<Method>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CompanionRequestOutput<Method>>;
  subscribe<Method extends CompanionStreamMethod>(
    method: Method,
    input: CompanionStreamInput<Method>,
    handlers: CompanionStreamHandlers<CompanionStreamItem<Method>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CompanionTransportSubscription>;
  close(reason?: string): Promise<void>;
}

export interface CompanionTransportConnectOptions {
  readonly url: string;
  readonly protocols: readonly string[];
  readonly signal: AbortSignal;
}

export interface CompanionTransportFactory {
  connect(options: CompanionTransportConnectOptions): Promise<CompanionTransport>;
}
