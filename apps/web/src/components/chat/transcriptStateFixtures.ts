// FILE: transcriptStateFixtures.ts
// Purpose: Deterministic transcript lifecycle fixtures for the dev transcript-state playground.
// Layer: Web dev tooling
// Exports: TRANSCRIPT_SCENARIOS, buildTranscriptScenarioState, TranscriptScenarioId

import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";

import { deriveTimelineEntries, type WorkLogEntry } from "../../session-logic";
import type { ChatMessage, TurnDiffSummary } from "../../types";

export type TranscriptScenarioId =
  | "sent"
  | "accepted"
  | "reasoning"
  | "tool-first"
  | "approval"
  | "user-input"
  | "reconnect"
  | "cancelled"
  | "stale-request"
  | "rate-limit"
  | "first-token"
  | "completed"
  | "startup-error";

export interface TranscriptScenario {
  readonly id: TranscriptScenarioId;
  readonly label: string;
  readonly phaseLabel: string;
  readonly description: string;
  readonly composerLabel: string;
  readonly defaultElapsedSeconds: number;
  readonly eventLabels: readonly string[];
}

export interface TranscriptScenarioState {
  readonly scenario: TranscriptScenario;
  readonly activeThreadId: ThreadId;
  readonly activeTurnId: TurnId | null;
  readonly activeTurnInProgress: boolean;
  readonly activeTurnStartedAt: string | null;
  readonly nowIso: string;
  readonly effectiveElapsedSeconds: number;
  readonly isWorking: boolean;
  readonly followLiveOutput: boolean;
  readonly visibleEventLabels: readonly string[];
  readonly nextEventLabel: string | null;
  readonly timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  readonly turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  readonly revertTurnCountByUserMessageId: Map<MessageId, number>;
}

const BASE_TIME_MS = Date.parse("2026-06-29T18:12:00.000Z");
const ACTIVE_THREAD_ID = ThreadId.makeUnsafe("transcript-state-lab");
const ACTIVE_TURN_ID = TurnId.makeUnsafe("transcript-state-lab-turn");
const EMPTY_TURN_DIFFS = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();

export const DEFAULT_TRANSCRIPT_SCENARIO: TranscriptScenario = {
  id: "sent",
  label: "Sent",
  phaseLabel: "Optimistic send",
  description: "The user message is local and no provider work has arrived yet.",
  composerLabel: "Sending is locked until the turn is accepted.",
  defaultElapsedSeconds: 3,
  eventLabels: ["user message inserted", "composer busy", "no server activity yet"],
};

export const TRANSCRIPT_SCENARIOS: readonly TranscriptScenario[] = [
  DEFAULT_TRANSCRIPT_SCENARIO,
  {
    id: "accepted",
    label: "Accepted",
    phaseLabel: "Server ack",
    description: "The provider accepted the turn, but no useful work or text has surfaced.",
    composerLabel: "Composer stays blocked, but the app can show that the turn is alive.",
    defaultElapsedSeconds: 5,
    eventLabels: ["user message inserted", "turn accepted", "waiting for first visible event"],
  },
  {
    id: "reasoning",
    label: "Reasoning",
    phaseLabel: "Thinking before text",
    description: "The first visible provider event is reasoning, not assistant text.",
    composerLabel: "Composer remains blocked while the live row says thinking, not typing.",
    defaultElapsedSeconds: 8,
    eventLabels: ["turn accepted", "reasoning progress", "no assistant message yet"],
  },
  {
    id: "tool-first",
    label: "Tool first",
    phaseLabel: "Tool-only activity",
    description: "A command runs before the first assistant token.",
    composerLabel: "Composer stays blocked while tool activity proves the agent is working.",
    defaultElapsedSeconds: 10,
    eventLabels: ["turn accepted", "searched files", "command details available"],
  },
  {
    id: "approval",
    label: "Approval",
    phaseLabel: "Blocked on approval",
    description: "The next visible state is an approval request, not a loading affordance.",
    composerLabel: "Composer should become an approval surface.",
    defaultElapsedSeconds: 11,
    eventLabels: ["command proposed", "approval requested", "turn paused before text"],
  },
  {
    id: "user-input",
    label: "User input",
    phaseLabel: "Blocked on answer",
    description: "The agent needs structured input before it can produce text.",
    composerLabel: "Composer should become a question-answer surface.",
    defaultElapsedSeconds: 12,
    eventLabels: ["question requested", "user answer pending", "no assistant prose yet"],
  },
  {
    id: "reconnect",
    label: "Reconnect",
    phaseLabel: "Connection interrupted",
    description: "The turn was accepted, then the app lost the provider connection before text.",
    composerLabel: "Composer should show disconnected/reconnecting state, not a live typing state.",
    defaultElapsedSeconds: 16,
    eventLabels: ["turn accepted", "transport disconnected", "waiting to reconcile turn state"],
  },
  {
    id: "cancelled",
    label: "Cancelled",
    phaseLabel: "Stopped before text",
    description: "The user stops the turn after startup, before any assistant token arrives.",
    composerLabel: "Composer should unlock immediately with the stopped turn preserved in history.",
    defaultElapsedSeconds: 7,
    eventLabels: ["turn accepted", "stop requested", "turn closed before assistant text"],
  },
  {
    id: "stale-request",
    label: "Stale request",
    phaseLabel: "Expired blocker",
    description: "A recovered approval or input callback is no longer valid after restart.",
    composerLabel: "Composer should clear the stale blocker and ask the user to restart the turn.",
    defaultElapsedSeconds: 18,
    eventLabels: ["request recovered", "provider rejects stale callback", "turn needs restart"],
  },
  {
    id: "first-token",
    label: "First token",
    phaseLabel: "Streaming answer",
    description: "The assistant row exists and markdown starts streaming.",
    composerLabel: "Composer can remain blocked, but transcript follow should attach to text.",
    defaultElapsedSeconds: 13,
    eventLabels: ["turn accepted", "tool/reasoning finished", "assistant text streaming"],
  },
  {
    id: "completed",
    label: "Completed",
    phaseLabel: "Settled turn",
    description: "The assistant answer has completed and transient work has settled.",
    composerLabel: "Composer should be ready for the next turn.",
    defaultElapsedSeconds: 22,
    eventLabels: ["assistant text completed", "work collapsed", "composer ready"],
  },
  {
    id: "rate-limit",
    label: "Rate limit",
    phaseLabel: "Waiting on capacity",
    description: "The provider pauses before the first token because capacity is unavailable.",
    composerLabel: "Composer should name the provider wait without implying local failure.",
    defaultElapsedSeconds: 24,
    eventLabels: ["turn accepted", "provider capacity wait", "retry window visible"],
  },
  {
    id: "startup-error",
    label: "Error",
    phaseLabel: "Failed before text",
    description: "Startup failed before a token could stream.",
    composerLabel: "Composer should recover with a retry path instead of staying busy.",
    defaultElapsedSeconds: 9,
    eventLabels: ["turn accepted", "provider startup failed", "turn unblocked"],
  },
];

export function buildTranscriptScenarioState(
  scenarioId: TranscriptScenarioId,
  elapsedSeconds: number,
): TranscriptScenarioState {
  const scenario = findScenario(scenarioId);
  const effectiveElapsedSeconds = Math.max(1, elapsedSeconds);
  const nowIso = isoAt(effectiveElapsedSeconds);
  const messages = filterVisibleMessages(buildMessages(scenario.id), nowIso);
  const workEntries = filterVisibleWorkEntries(buildWorkEntries(scenario.id), nowIso);
  const visibleEventLabels = deriveVisibleEventLabels(scenario, effectiveElapsedSeconds);
  const closedBeforeText =
    scenario.id === "cancelled" ||
    scenario.id === "reconnect" ||
    scenario.id === "stale-request" ||
    scenario.id === "completed" ||
    scenario.id === "startup-error";
  const blocked = scenario.id === "approval" || scenario.id === "user-input";
  const hasStreamingAssistant = messages.some(
    (message) => message.role === "assistant" && message.streaming,
  );
  const hasLiveWork = workEntries.some(
    (entry) => entry.tone === "thinking" || entry.tone === "tool",
  );

  return {
    scenario,
    activeThreadId: ACTIVE_THREAD_ID,
    activeTurnId: closedBeforeText ? null : ACTIVE_TURN_ID,
    activeTurnInProgress: !closedBeforeText,
    activeTurnStartedAt: scenario.id === "sent" ? isoAt(0) : isoAt(1),
    nowIso,
    effectiveElapsedSeconds,
    isWorking:
      scenario.id === "sent" ||
      scenario.id === "accepted" ||
      scenario.id === "reasoning" ||
      scenario.id === "tool-first" ||
      scenario.id === "first-token" ||
      scenario.id === "reconnect" ||
      scenario.id === "rate-limit",
    followLiveOutput: !closedBeforeText && !blocked && (hasLiveWork || hasStreamingAssistant),
    visibleEventLabels,
    nextEventLabel: scenario.eventLabels[visibleEventLabels.length] ?? null,
    timelineEntries: deriveTimelineEntries(messages, [], workEntries),
    turnDiffSummaryByAssistantMessageId: EMPTY_TURN_DIFFS,
    revertTurnCountByUserMessageId: EMPTY_REVERT_COUNTS,
  };
}

function findScenario(scenarioId: TranscriptScenarioId): TranscriptScenario {
  return (
    TRANSCRIPT_SCENARIOS.find((scenario) => scenario.id === scenarioId) ??
    DEFAULT_TRANSCRIPT_SCENARIO
  );
}

function buildMessages(scenarioId: TranscriptScenarioId): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      id: userMessageIdForScenario(scenarioId),
      role: "user",
      text: promptTextForScenario(scenarioId),
      createdAt: isoAt(0),
      streaming: false,
      turnId: ACTIVE_TURN_ID,
    },
  ];

  if (scenarioId === "first-token" || scenarioId === "completed") {
    messages.push({
      id: assistantMessageIdForScenario(scenarioId),
      role: "assistant",
      text: [
        "The important distinction is ack versus text.",
        "",
        "I would keep the sent message stable, show concrete work when it exists, and only switch to transcript-follow once assistant text starts streaming.",
      ].join("\n"),
      createdAt: isoAt(12),
      ...(scenarioId === "completed" ? { completedAt: isoAt(18) } : {}),
      streaming: scenarioId === "first-token",
      turnId: ACTIVE_TURN_ID,
    });
  }

  return messages;
}

function userMessageIdForScenario(scenarioId: TranscriptScenarioId): MessageId {
  return MessageId.makeUnsafe(`transcript-state-lab-user-${scenarioId}`);
}

function assistantMessageIdForScenario(scenarioId: TranscriptScenarioId): MessageId {
  return MessageId.makeUnsafe(`transcript-state-lab-assistant-${scenarioId}`);
}

function promptTextForScenario(scenarioId: TranscriptScenarioId): string {
  switch (scenarioId) {
    case "sent":
      return "Send this turn and keep the message stable while the provider has not acknowledged it yet.";
    case "accepted":
      return "Show me that the server accepted the turn even before useful agent activity is visible.";
    case "reasoning":
      return "Trace the transcript startup path and make thinking visible before assistant prose exists.";
    case "tool-first":
      return "Inspect the code path for first-token latency and show tool work before any answer text.";
    case "approval":
      return "Run the focused transcript verification once the shell approval is safe to grant.";
    case "user-input":
      return "Help decide which pre-token interaction should get the closest polish pass.";
    case "reconnect":
      return "Continue this accepted turn after a provider reconnect without losing the transcript state.";
    case "cancelled":
      return "Stop this turn before assistant text starts and leave the history understandable.";
    case "stale-request":
      return "Recover after a restored approval callback turns out to be stale.";
    case "rate-limit":
      return "Wait through provider capacity pressure without implying the local app is broken.";
    case "first-token":
      return "Compare the time between sending and the first assistant token, then start streaming the answer.";
    case "completed":
      return "Finish the send-to-first-token comparison and leave the composer ready for the next turn.";
    case "startup-error":
      return "Handle a provider startup failure before any assistant token arrives.";
  }
}

function buildWorkEntries(scenarioId: TranscriptScenarioId): WorkLogEntry[] {
  switch (scenarioId) {
    case "sent":
      return [];
    case "accepted":
      return [];
    case "reasoning":
      return [thinkingEntry("reasoning", 3, "Reading recent conversation and workspace state")];
    case "tool-first":
      return [
        thinkingEntry("reasoning", 3, "Planning the comparison points"),
        commandEntry(
          "tool-first-search",
          6,
          "Searched",
          'rg -n "isWorking|activeTurnStartedAt" apps/web/src/components',
          "apps/web/src/components/ChatView.tsx:2442",
        ),
      ];
    case "approval":
      return [
        approvalCommandEntry(
          "approval-command",
          5,
          "Command needs approval",
          "bun run typecheck",
          "Waiting for explicit approval before running a workspace check.",
        ),
      ];
    case "user-input":
      return [
        infoEntry(
          "user-input-request",
          5,
          "Input required",
          "question: Which interaction state should get the closest polish pass?",
        ),
      ];
    case "reconnect":
      return [
        infoEntry(
          "reconnect-disconnected",
          5,
          "Connection interrupted",
          "The provider session disconnected before the first assistant token.",
        ),
        infoEntry(
          "reconnect-reconciling",
          12,
          "Reconnecting",
          "Waiting to reconcile whether the accepted turn is still running.",
        ),
      ];
    case "cancelled":
      return [infoEntry("cancelled", 5, "Turn stopped", "Stopped before assistant text began.")];
    case "stale-request":
      return [
        {
          id: "stale-request",
          createdAt: isoAt(9),
          turnId: ACTIVE_TURN_ID,
          label: "Stale pending request",
          detail:
            "Provider callback state did not survive restart. Restart the turn to continue.",
          tone: "error",
        },
      ];
    case "first-token":
    case "completed":
      return [
        thinkingEntry("reasoning", 3, "Checking the send path"),
        commandEntry(
          "first-token-search",
          7,
          "Searched",
          'rg -n "deriveTimelineEntries" apps/web/src',
          "apps/web/src/session-logic.timeline.ts:43",
        ),
      ];
    case "rate-limit":
      return [];
    case "startup-error":
      return [
        {
          id: "startup-error",
          createdAt: isoAt(5),
          turnId: ACTIVE_TURN_ID,
          label: "Provider startup failed",
          detail: "The app-server process exited before the first response event.",
          tone: "error",
        },
      ];
  }
}

function filterVisibleMessages(messages: ChatMessage[], nowIso: string): ChatMessage[] {
  return messages.filter((message) => message.createdAt <= nowIso);
}

function filterVisibleWorkEntries(entries: WorkLogEntry[], nowIso: string): WorkLogEntry[] {
  return entries.filter((entry) => entry.createdAt <= nowIso);
}

function deriveVisibleEventLabels(
  scenario: TranscriptScenario,
  elapsedSeconds: number,
): readonly string[] {
  const thresholds = eventThresholdsForScenario(scenario.id);
  return scenario.eventLabels.filter((_, index) => elapsedSeconds >= (thresholds[index] ?? 0));
}

function eventThresholdsForScenario(
  scenarioId: TranscriptScenarioId,
): readonly [number, number, number] {
  switch (scenarioId) {
    case "sent":
      return [0, 1, 3];
    case "accepted":
      return [0, 2, 5];
    case "reasoning":
      return [1, 3, 8];
    case "tool-first":
      return [1, 6, 10];
    case "approval":
      return [1, 5, 11];
    case "user-input":
      return [1, 5, 12];
    case "reconnect":
      return [1, 5, 12];
    case "cancelled":
      return [1, 4, 7];
    case "stale-request":
      return [1, 9, 18];
    case "rate-limit":
      return [1, 5, 24];
    case "first-token":
      return [1, 7, 12];
    case "completed":
      return [18, 20, 22];
    case "startup-error":
      return [1, 5, 9];
  }
}

function infoEntry(id: string, seconds: number, label: string, detail: string): WorkLogEntry {
  return {
    id,
    createdAt: isoAt(seconds),
    turnId: ACTIVE_TURN_ID,
    label,
    detail,
    tone: "info",
  };
}

function thinkingEntry(id: string, seconds: number, label: string): WorkLogEntry {
  return {
    id,
    createdAt: isoAt(seconds),
    turnId: ACTIVE_TURN_ID,
    label,
    tone: "thinking",
  };
}

function commandEntry(
  id: string,
  seconds: number,
  title: string,
  command: string,
  stdout: string,
): WorkLogEntry {
  return {
    id,
    createdAt: isoAt(seconds),
    turnId: ACTIVE_TURN_ID,
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    toolTitle: title,
    command,
    toolDetails: {
      kind: "command",
      title,
      command,
      output: { stdout },
    },
  };
}

function approvalCommandEntry(
  id: string,
  seconds: number,
  title: string,
  command: string,
  stdout: string,
): WorkLogEntry {
  return {
    ...commandEntry(id, seconds, title, command, stdout),
    label: "Approval requested",
    detail: `shell: {"command":"${command}"}`,
    requestKind: "command",
  };
}

function isoAt(seconds: number): string {
  return new Date(BASE_TIME_MS + seconds * 1_000).toISOString();
}
