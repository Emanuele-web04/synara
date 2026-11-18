// Perf probe: the per-flush derivation chain ChatView and MessagesTimeline re-run whenever a
// long thread's activities or messages change, on real-shape detail snapshots.
//   SYNARA_PERF=1 bunx vitest run perf/longChatDerivations.perf.test.ts
// Fixtures: the cold snapshot frames written by
//   node benchmarks/desktop-perf/longchat.mjs --build <name> --capture
// (benchmarks/desktop-perf/results/frames/frame-<thread>.json; override with SYNARA_PERF_DIR).
// Guard: fails when the chain for one activity event exceeds 10x its measured cost
// (~5 ms on agent-heavy), which catches accidental quadratic work, not small drifts.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  foldSubagentRunWorkEntries,
  scanSubagentRunCards,
} from "../src/components/chat/SubagentRunCard.logic";
import { deriveAgentActivityTimelineState } from "../src/components/chat/agentActivity.logic";
import { deriveMessageTrailItems } from "../src/components/chat/messageTrail.logic";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveTurnTimingByTurnId,
} from "../src/components/chat/MessagesTimeline.logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
} from "../src/pendingInteractionDerivation";
import { deriveRunningSubagentTasks, deriveWorkLogEntries } from "../src/session-logic";
import { normalizeThreadFromReadModel } from "../src/storeNormalization";
import { deriveSubagentTaskEnds, deriveTimelineEntries } from "../src/workLog";

const ENABLED = process.env.SYNARA_PERF === "1";
const FIXTURE_DIR =
  process.env.SYNARA_PERF_DIR ??
  fileURLToPath(new URL("../../../benchmarks/desktop-perf/results/frames", import.meta.url));
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
function time<T>(run: () => T, iterations = 15): { ms: number; value: T } {
  let value = run();
  for (let i = 0; i < 3; i += 1) value = run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const startedAt = performance.now();
    value = run();
    samples.push(performance.now() - startedAt);
  }
  return { ms: Math.round(median(samples) * 100) / 100, value };
}

describe.skipIf(!ENABLED)("long chat derivations perf", () => {
  for (const name of ["small-38", "prose-300", "agent-mid", "agent-heavy", "synthetic-1400"]) {
    const fixture = `${FIXTURE_DIR}/frame-${name}.json`;
    it.skipIf(!existsSync(fixture))(`derivations ${name}`, () => {
      const raw = readFileSync(fixture, "utf8");
      const parse = time(() => JSON.parse(raw));
      const incoming = parse.value.values[0].snapshot.thread;
      const normalize = time(() => normalizeThreadFromReadModel(incoming, undefined, 1));
      const thread = normalize.value;
      const visibleTurnIds = new Set<string>();
      for (const message of thread.messages) if (message.turnId) visibleTurnIds.add(message.turnId);
      const latestTurnId = thread.latestTurn?.turnId ?? undefined;
      const workLog = time(() =>
        deriveWorkLogEntries(thread.activities, latestTurnId, {
          visibleTurnIds: visibleTurnIds as never,
          activeTurnId: null,
          activeTurnStartedAt: thread.latestTurn?.startedAt ?? null,
          latestTurnState: thread.latestTurn?.state ?? null,
          latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
        }),
      );
      const folded = time(() => foldSubagentRunWorkEntries(workLog.value));
      const agentState = time(() => deriveAgentActivityTimelineState(folded.value));
      const timeline = time(() =>
        deriveTimelineEntries(
          thread.messages as never,
          thread.proposedPlans as never,
          agentState.value.timelineWorkEntries as never,
        ),
      );
      const turnTiming = time(() =>
        deriveTurnTimingByTurnId({
          turnDiffSummaries: thread.turnDiffSummaries,
          latestTurn: thread.latestTurn,
          activities: thread.activities,
        }),
      );
      const rows = time(() =>
        deriveMessagesTimelineRows({
          timelineEntries: timeline.value,
          isWorking: false,
          worktreeSetup: null,
          worktreeSetupOpen: false,
          activeTurnInProgress: false,
          collapseFinishedTurns: true,
          activeTurnId: null,
          activeTurnStartedAt: null,
          turnDiffSummaryByAssistantMessageId: new Map(),
          revertTurnCountByUserMessageId: new Map(),
          turnTimingByTurnId: turnTiming.value,
        }),
      );
      const firstStable = computeStableMessagesTimelineRows(rows.value, {
        byId: new Map(),
        result: [],
      });
      const freshRows = deriveMessagesTimelineRows({
        timelineEntries: timeline.value,
        isWorking: false,
        worktreeSetup: null,
        worktreeSetupOpen: false,
        activeTurnInProgress: false,
        collapseFinishedTurns: true,
        activeTurnId: null,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
        turnTimingByTurnId: turnTiming.value,
      });
      const stable = time(() => computeStableMessagesTimelineRows(freshRows, firstStable));
      const trail = time(() => deriveMessageTrailItems(timeline.value));
      const subagentScan = time(() =>
        scanSubagentRunCards({
          entries: folded.value,
          threads: [],
          parentThreadId: thread.id,
          liveTurnId: null,
          taskEndByToolUseId: new Map(),
          backgroundedProviderThreadIds: new Set(),
          runtimeRetired: false,
        } as never),
      );
      const running = time(() =>
        deriveRunningSubagentTasks({
          activities: thread.activities,
          liveTurnId: null,
          sessionStatus: null,
        } as never),
      );
      const taskEnds = time(() => deriveSubagentTaskEnds(thread.activities as never));
      const approvals = time(() => derivePendingApprovals(thread.activities as never));
      const userInputs = time(() => derivePendingUserInputs(thread.activities as never));
      const activityChain =
        workLog.ms +
        folded.ms +
        agentState.ms +
        timeline.ms +
        turnTiming.ms +
        rows.ms +
        stable.ms +
        trail.ms +
        subagentScan.ms +
        running.ms +
        taskEnds.ms +
        approvals.ms +
        userInputs.ms;
      const messageChain = timeline.ms + rows.ms + stable.ms + trail.ms;
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          name,
          messages: thread.messages.length,
          activities: thread.activities.length,
          workEntries: workLog.value.length,
          timelineEntries: timeline.value.length,
          rows: rows.value.length,
          ms: {
            jsonParse: parse.ms,
            normalizeThread: normalize.ms,
            deriveWorkLogEntries: workLog.ms,
            foldSubagentRunWorkEntries: folded.ms,
            deriveAgentActivityTimelineState: agentState.ms,
            deriveTimelineEntries: timeline.ms,
            deriveTurnTimingByTurnId: turnTiming.ms,
            deriveMessagesTimelineRows: rows.ms,
            computeStableRows: stable.ms,
            deriveMessageTrailItems: trail.ms,
            scanSubagentRunCards: subagentScan.ms,
            deriveRunningSubagentTasks: running.ms,
            deriveSubagentTaskEnds: taskEnds.ms,
            derivePendingApprovals: approvals.ms,
            derivePendingUserInputs: userInputs.ms,
            perActivityEventChain: Math.round(activityChain * 100) / 100,
            perMessageFlushChain: Math.round(messageChain * 100) / 100,
          },
        }),
      );
      expect(rows.value.length).toBeGreaterThan(0);
      expect(activityChain).toBeLessThan(50);
    });
  }
});
