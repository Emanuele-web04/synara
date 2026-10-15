import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive as OrchestrationProjectionSnapshotQueryBase } from "./ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const OrchestrationProjectionSnapshotQueryLive = OrchestrationProjectionSnapshotQueryBase.pipe(
  Layer.provide(ServerSettingsService.layerTest()),
);

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

// Opt-in only (issue #1900): grows one thread's activity history through the real
// engine and times the per-event reads that scale with that history.
it.skipIf(!process.env.SYNARA_HISTORY_BENCHMARK_OUTPUT)(
  "measures thread reads as activity history grows",
  async () => {
    const output = process.env.SYNARA_HISTORY_BENCHMARK_OUTPUT!;
    const milestones = (process.env.SYNARA_HISTORY_BENCHMARK_MILESTONES ?? "1000,5000,20000")
      .split(",")
      .map(Number);
    const payloadBytes = Number(process.env.SYNARA_HISTORY_BENCHMARK_PAYLOAD_BYTES ?? 4_000);
    const samples = 5;
    const dir = await mkdtemp(join(tmpdir(), "synara-history-benchmark-"));
    const dbPath = join(dir, "state.sqlite");
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), dir)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
      const createdAt = "2026-10-15T12:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("history-project");
      const threadId = ThreadId.makeUnsafe("history-thread");
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("project"),
          projectId,
          title: "History",
          workspaceRoot: dir,
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("thread"),
          threadId,
          projectId,
          title: "History",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      const output_ = "x".repeat(payloadBytes);
      const results: Array<Record<string, number>> = [];
      let appended = 0;
      for (const target of milestones) {
        const appendStarted = performance.now();
        for (; appended < target; appended += 1) {
          // One approval request per 50 rows, most of them answered: the requests
          // that leave the window are what made each detail read quadratic.
          const approval = appended % 50;
          const requestId = `request-${Math.floor(appended / 50)}`;
          await runtime.runPromise(
            engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(`activity-${appended}`),
              threadId,
              activity: {
                id: EventId.makeUnsafe(`activity-${appended}`),
                tone: approval < 2 ? "approval" : "tool",
                kind:
                  approval === 0
                    ? "approval.requested"
                    : approval === 1 && Math.floor(appended / 50) % 10 !== 0
                      ? "approval.resolved"
                      : appended % 2 === 0
                        ? "tool.started"
                        : "tool.completed",
                summary: approval < 2 ? "Approval" : "Ran command",
                payload:
                  approval < 2
                    ? { requestId, requestKind: "command", detail: "Command: ls" }
                    : {
                        itemType: "command_execution",
                        data: { item: { type: "command_execution", aggregated_output: output_ } },
                      },
                turnId: TurnId.makeUnsafe(`turn-${Math.floor(appended / 200)}`),
                createdAt,
              },
              createdAt,
            }),
          );
        }
        const appendMs = performance.now() - appendStarted;
        const detailMs: number[] = [];
        const withoutActivitiesMs: number[] = [];
        const shellMs: number[] = [];
        for (let sample = 0; sample < samples; sample += 1) {
          let started = performance.now();
          const detail = await runtime.runPromise(snapshots.getThreadDetailById(threadId));
          detailMs.push(performance.now() - started);
          expect(detail._tag).toBe("Some");
          started = performance.now();
          // Absent on builds before #1900; the field then stays empty.
          if ("getThreadDetailWithoutActivitiesById" in snapshots) {
            await runtime.runPromise(snapshots.getThreadDetailWithoutActivitiesById(threadId));
            withoutActivitiesMs.push(performance.now() - started);
          }
          started = performance.now();
          await runtime.runPromise(snapshots.getThreadShellById(threadId));
          shellMs.push(performance.now() - started);
        }
        const [size] = await runtime.runPromise(
          sql<{
            readonly bytes: number;
          }>`SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()`,
        );
        results.push({
          activities: target,
          dbBytes: size?.bytes ?? 0,
          appendMsPerActivity: appendMs / Math.max(1, target - (results.at(-1)?.activities ?? 0)),
          getThreadDetailByIdMedianMs: median(detailMs),
          getThreadDetailWithoutActivitiesByIdMedianMs: median(withoutActivitiesMs),
          getThreadShellByIdMedianMs: median(shellMs),
        });
      }
      await writeFile(
        output,
        JSON.stringify(
          {
            environment: {
              node: process.version,
              os: `${platform()} ${release()}`,
              cpu: cpus()[0]?.model,
            },
            workload: { payloadBytes, samples },
            results,
          },
          null,
          2,
        ),
      );
    } finally {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60 * 60_000,
);
