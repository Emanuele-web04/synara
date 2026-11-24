import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

/**
 * How long a request may wait to acquire a pooled connection (or to open a
 * new one) before it fails as a retryable server fault (JSON 500). Below the
 * desktop client's 15 s request timeout, so an exhausted or unreachable pool
 * answers instead of hanging until the client gives up. Every acquisition
 * (`pool.connect()`, `pool.query`, Drizzle transactions) happens before the
 * caller's try/ROLLBACK/release, so a timed-out acquire never touches a
 * client. No statement or query timeout is set.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * How long an idle client stays open. Polls arrive further apart than pg's
 * default 10 s, which closed and reopened a connection (a pooler
 * authentication and a DISCARD ALL) for most of them.
 */
export const POOL_IDLE_TIMEOUT_MS = 60_000;

export function createDb(databaseUrl: string): {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    keepAlive: true,
  });
  // An idle client the server or pooler drops emits `error` on the pool;
  // without a listener that is an unhandled event that crashes the process.
  // pg removes the broken client itself. The error text can carry connection
  // details, so only a fixed line is logged.
  pool.on("error", () => {
    console.error("[api] Idle database connection closed");
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
