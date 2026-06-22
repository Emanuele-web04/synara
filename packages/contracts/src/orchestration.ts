// Purpose: Public entry for orchestration contracts. Owns the WebSocket method/
//   channel maps and re-exports the cohesive sub-modules (core read-model shapes,
//   commands, events/RPC) so consumers keep a single `@t3tools/contracts` surface.
// Layer: contracts (schema-only)
// Exports: ORCHESTRATION_WS_METHODS, ORCHESTRATION_WS_CHANNELS, the providerKind
//   re-exports, and everything from orchestration.core / .commands / .events.

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  getShellSnapshot: "orchestration.getShellSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  importThread: "orchestration.importThread",
  repairState: "orchestration.repairState",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
  subscribeShell: "orchestration.subscribeShell",
  unsubscribeShell: "orchestration.unsubscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  unsubscribeThread: "orchestration.unsubscribeThread",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
  shellEvent: "orchestration.shellEvent",
  threadEvent: "orchestration.threadEvent",
} as const;

export {
  DEFAULT_PROVIDER_KIND,
  ProviderApprovalPolicy,
  ProviderKind,
  ProviderSandboxMode,
} from "./providerKind";

export * from "./orchestration.core";
export * from "./orchestration.commands";
export * from "./orchestration.events";
