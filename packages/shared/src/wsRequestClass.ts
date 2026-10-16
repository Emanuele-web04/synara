// FILE: wsRequestClass.ts
// Purpose: Per-connection unary RPC classes and their concurrency budgets.
// Layer: Shared server/web protocol policy
// Why: The server admits at most this many unary requests per class and
//      connection and rejects the rest; the web transport queues against the same
//      budgets so it never sends a request the server would reject.

import { ORCHESTRATION_WS_METHODS, WS_METHODS, WsRpcError } from "@synara/contracts";

export type WsRequestClass = "control" | "standard" | "expensive-read";

export const WS_REQUEST_CLASS_LIMITS: Readonly<Record<WsRequestClass, number>> = {
  control: 16,
  standard: 12,
  "expensive-read": 2,
};

const CONTROL_METHODS = new Set<string>([
  WS_METHODS.serverGetRuntimeStatus,
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  ORCHESTRATION_WS_METHODS.settleTurnDispatch,
  ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
  ORCHESTRATION_WS_METHODS.prepareQuitResume,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalAckOutput,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClose,
  WS_METHODS.serverStopLocalServer,
  WS_METHODS.providerStopIdleRuntimeSession,
  WS_METHODS.automationCancelRun,
  WS_METHODS.automationMarkRunRead,
  WS_METHODS.automationArchiveRun,
]);

const EXPENSIVE_READ_METHODS = new Set<string>([
  ORCHESTRATION_WS_METHODS.listProjectImports,
  ORCHESTRATION_WS_METHODS.loadProjectImportHistory,
  ORCHESTRATION_WS_METHODS.getSnapshot,
  ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
  ORCHESTRATION_WS_METHODS.searchThreads,
  ORCHESTRATION_WS_METHODS.repairState,
  ORCHESTRATION_WS_METHODS.getTurnDiff,
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_WS_METHODS.getInlineVisual,
  ORCHESTRATION_WS_METHODS.replayEvents,
  ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsSearchLocalEntries,
  WS_METHODS.projectsSearchContent,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsResolveWorkspaceFileReferences,
  WS_METHODS.studioListThreadOutputs,
  WS_METHODS.filesystemBrowse,
  WS_METHODS.gitStatus,
  WS_METHODS.gitReadWorkingTreeDiff,
  WS_METHODS.gitBlameLine,
  WS_METHODS.gitReadFileAtRev,
  WS_METHODS.gitListRecentCommits,
  WS_METHODS.gitWorkingTreeDiffStats,
  WS_METHODS.gitSummarizeDiff,
  WS_METHODS.gitPullRequestSnapshot,
  WS_METHODS.serverGetProviderUsageSnapshot,
  WS_METHODS.serverListProviderUsage,
  WS_METHODS.serverGetDiagnostics,
  WS_METHODS.serverPrewarmVoice,
  WS_METHODS.serverGenerateThreadRecap,
  WS_METHODS.serverGenerateAutomationIntent,
  WS_METHODS.serverTranscribeVoice,
  WS_METHODS.statsGetProfileStats,
  WS_METHODS.statsGetProfileTokenStats,
  WS_METHODS.statsGetRecap,
  WS_METHODS.providerCompactThread,
  WS_METHODS.providerListCommands,
  WS_METHODS.providerListSkills,
  WS_METHODS.providerListSkillsCatalog,
  WS_METHODS.providerListPlugins,
  WS_METHODS.providerReadPlugin,
  WS_METHODS.providerListModels,
  WS_METHODS.providerListAgents,
]);

export function classifyWsRequest(method: string): WsRequestClass {
  if (CONTROL_METHODS.has(method)) return "control";
  if (EXPENSIVE_READ_METHODS.has(method)) return "expensive-read";
  return "standard";
}

export const WS_REQUEST_CAPACITY_RETRY_AFTER_MS = 250;

export const WS_REQUEST_CAPACITY_EXCEEDED_CODES = [
  "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
  "RPC_REQUEST_CAPACITY_EXCEEDED",
] as const;

/** The retryable rejection for a class whose budget is in use. */
export function makeWsRequestCapacityError(requestClass: WsRequestClass): WsRpcError {
  return new WsRpcError({
    message: `WebSocket ${requestClass} request capacity exceeded.`,
    code:
      requestClass === "expensive-read"
        ? "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED"
        : "RPC_REQUEST_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: WS_REQUEST_CAPACITY_RETRY_AFTER_MS,
  });
}
