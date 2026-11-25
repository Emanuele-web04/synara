// FILE: betaUsageSnapshot.ts
// Purpose: Computes the anonymous last-24h usage snapshot for Synara Beta and Remote.
// Layer: Server maintenance task — runs only on Beta and Remote desktop builds.
//
// The desktop main process cannot reach the projection database, so the server
// writes counts to <betaHome>/diagnostics/usage-snapshot.json and the main
// process relays them as one `usage.daily` diagnostics event per UTC day.
// Only fixed health counts are written. Model/effort/token usage belongs to the
// product-consent pipeline in hostUsageSnapshot.ts. Never thread titles,
// paths, prompts, or provider payloads.

import { Effect, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "./atomicWrite";

export const BETA_USAGE_SNAPSHOT_FILE_NAME = "usage-snapshot.json";
export const BETA_USAGE_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BETA_USAGE_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CountRow {
  readonly n: number;
}

/** Writes one snapshot. Fails the returned Effect on error; callers catch. */
export const writeBetaUsageSnapshot = (betaHomeDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;
    const since = new Date(Date.now() - BETA_USAGE_SNAPSHOT_WINDOW_MS).toISOString();

    const projects = yield* sql<CountRow>`
      SELECT COUNT(*) AS n FROM projection_projects WHERE deleted_at IS NULL
    `;
    const activeThreads = yield* sql<CountRow>`
      SELECT COUNT(DISTINCT thread_id) AS n FROM projection_turns WHERE requested_at >= ${since}
    `;
    const snapshot = {
      v: 1,
      generatedAt: new Date().toISOString(),
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
