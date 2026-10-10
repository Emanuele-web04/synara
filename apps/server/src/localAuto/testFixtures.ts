import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type ProviderRuntimeEvent,
  type ProviderRuntimeRequestOpenedEvent,
} from "@synara/contracts";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns";
export const threadId = ThreadId.makeUnsafe("auto-test");
export const turnId = TurnId.makeUnsafe("turn-test");
export const userMessage: OrchestrationMessage = {
  id: MessageId.makeUnsafe("user-1"),
  role: "user",
  text: "Clean up the build artifacts and reinstall dependencies.",
  turnId: null,
  streaming: false,
  startsNewTurn: true,
  source: "native",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};
export const turn: ProjectionTurn = {
  threadId,
  turnId,
  pendingMessageId: userMessage.id,
  sourceProposedPlanThreadId: null,
  sourceProposedPlanId: null,
  assistantMessageId: null,
  state: "running",
  requestedAt: userMessage.createdAt,
  startedAt: userMessage.createdAt,
  completedAt: null,
  checkpointTurnCount: null,
  checkpointRef: null,
  checkpointStatus: null,
  checkpointFiles: [],
};
export const request = {
  type: "request.opened",
  eventId: EventId.makeUnsafe("request-1"),
  provider: "claudeAgent",
  threadId,
  turnId,
  requestId: "approval-1",
  lifecycleGeneration: "generation-1",
  createdAt: "2026-09-13T00:00:02.000Z",
  payload: {
    requestType: "command_execution_approval",
    args: { toolName: "Bash", input: { command: "rm -rf node_modules dist && npm install" } },
  },
} as ProviderRuntimeRequestOpenedEvent;
export const started = {
  ...request,
  eventId: EventId.makeUnsafe("start-1"),
  type: "turn.started",
  createdAt: "2026-09-13T00:00:01.000Z",
  payload: {},
} as ProviderRuntimeEvent;
export const context = { request, events: [started], messages: [userMessage], turns: [turn] };
