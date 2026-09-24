// FILE: betaUsageSnapshot.ts
// Purpose: Computes the anonymous last-24h usage snapshot for Synara Beta.
// Layer: Server maintenance task — runs only on beta-flavor desktop builds.
//
// The desktop main process cannot reach the projection database, so the server
// writes counts to <betaHome>/diagnostics/usage-snapshot.json and the main
// process relays them as one `usage.daily` diagnostics event per UTC day.
// Only counts and provider names are written — never thread titles, paths,
// prompts, or provider payloads.

import { Effect, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "./atomicWrite";

export const BETA_USAGE_SNAPSHOT_FILE_NAME = "usage-snapshot.json";
export const BETA_USAGE_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BETA_USAGE_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Terminal failure states from ProjectionTurnState ("pending" | "running" |
// "interrupted" | "completed" | "error"). An in-flight turn is not a failure.
const FAILED_TURN_STATES = ["interrupted", "error"] as const;

interface ProviderUsageRow {
  readonly provider: string;
  readonly threads: number;
  readonly turns: number;
  readonly turnsFailed: number | null;
}

interface CountRow {
  readonly n: number;
}

/** Writes one snapshot. Fails the returned Effect on error; callers catch. */
export const writeBetaUsageSnapshot = (betaHomeDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;
    const since = new Date(Date.now() - BETA_USAGE_SNAPSHOT_WINDOW_MS).toISOString();

    const providers = yield* sql<ProviderUsageRow>`
      SELECT s.provider_name AS provider, COUNT(DISTINCT t.thread_id) AS threads,
             COUNT(*) AS turns,
             SUM(CASE WHEN t.state IN ${sql.in(FAILED_TURN_STATES)} THEN 1 ELSE 0 END) AS turnsFailed
      FROM projection_turns t
      JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      WHERE t.requested_at >= ${since} AND s.provider_name IS NOT NULL
      GROUP BY s.provider_name
    `;
    const projects = yield* sql<CountRow>`
      SELECT COUNT(*) AS n FROM projection_projects WHERE deleted_at IS NULL
    `;
    const activeThreads = yield* sql<CountRow>`
      SELECT COUNT(DISTINCT thread_id) AS n FROM projection_turns WHERE requested_at >= ${since}
    `;

    const snapshot = {
      v: 1,
      generatedAt: new Date().toISOString(),
      providers: providers.map((row) => ({
        provider: row.provider,
        threads: Number(row.threads),
        turns: Number(row.turns),
        turnsFailed: Number(row.turnsFailed ?? 0),
      })),
      projects: Number(projects[0]?.n ?? 0),
      activeThreads: Number(activeThreads[0]?.n ?? 0),
    };
    yield* writeFileStringAtomically({
      filePath: path.join(betaHomeDir, "diagnostics", BETA_USAGE_SNAPSHOT_FILE_NAME),
      contents: `${JSON.stringify(snapshot)}\n`,
    });
  });

/**
 * Snapshot at call time, then every 6h. Each write failure is logged and the
 * loop keeps going — diagnostics must never affect server startup or uptime.
 */
export const startBetaUsageSnapshotJob = (betaHomeDir: string) =>
  Effect.gen(function* () {
    while (true) {
      yield* writeBetaUsageSnapshot(betaHomeDir).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("beta usage snapshot write failed").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
      );
      yield* Effect.sleep(BETA_USAGE_SNAPSHOT_INTERVAL_MS);
    }
  }).pipe(Effect.forkScoped);
