import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { SaveInboxRecapRequest } from "@synara/contracts";
import { createAccountClient } from "@synara/shared/account";
import { ACCOUNT_INBOX_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { recapInputForRange, resolveInboxDay } from "@synara/shared/inboxDay";
import { accountStateDirectory, readAccountCredentials, withFreshAccessToken } from "./accountAuth";
import { writeFileStringAtomically } from "./atomicWrite";
import { isServerBetaFeatureEnabled } from "./betaFeatureGate";
import type { RecapStatsQueryShape } from "./recapStats";

/** Runs on the source computer, independently of any connected UI or phone.
 * Absolute upserts make retries safe. Each account/host/timezone has its own
 * durable catch-up cursor; failed uploads never advance it. Current activity
 * syncs first, then at most four historical days per minute (below API limits).
 */
export function createAccountInboxReporter(options: {
  readonly baseDir: string;
  readonly devUrl?: URL;
  readonly sql: SqlClient.SqlClient;
  readonly recapQuery: RecapStatsQueryShape;
}) {
  const credentialDir = accountStateDirectory(options.baseDir, options.devUrl);
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSnapshot: string | undefined;

  async function sync() {
    if (stopped || !isServerBetaFeatureEnabled(ACCOUNT_INBOX_BETA_FEATURE)) return;
    const account = await readAccountCredentials(credentialDir);
    if (!account?.userId || !account.organizationId || !account.hostId) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const identity = createHash("sha256")
      .update(
        JSON.stringify([
          account.accountUrl,
          account.userId,
          account.organizationId,
          account.hostId,
          timezone,
        ]),
      )
      .digest("hex");
    const cursorPath = join(credentialDir, "inbox-sync", `${identity}.json`);
    const today = resolveInboxDay(Date.now());
    const client = createAccountClient({ baseUrl: account.accountUrl });
    let cursor: number;
    let eventSequence = 0;
    try {
      const saved: unknown = JSON.parse(await readFile(cursorPath, "utf8"));
      // Older versions persisted just the catch-up cursor. The event checkpoint
      // belongs to the same account/host/timezone and starts at zero on upgrade.
      const state = typeof saved === "number" ? { cursor: saved, eventSequence: 0 } : saved;
      if (
        !state ||
        typeof state !== "object" ||
        !("cursor" in state) ||
        !("eventSequence" in state) ||
        typeof state.cursor !== "number" ||
        !Number.isFinite(state.cursor) ||
        state.cursor < 0 ||
        resolveInboxDay(state.cursor).fromMs !== state.cursor ||
        typeof state.eventSequence !== "number" ||
        !Number.isSafeInteger(state.eventSequence) ||
        state.eventSequence < 0
      )
        throw new Error("Invalid Inbox cursor");
      cursor = Math.min(state.cursor, today.fromMs);
      eventSequence = state.eventSequence;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Cover live and purged-thread archives without deriving a second set of metrics.
      const sql = options.sql;
      const [first] = await Effect.runPromise(sql<{ firstAt: string | null }>`
        SELECT MIN(first_at) AS firstAt FROM (
          SELECT MIN(created_at) AS first_at FROM projection_thread_messages
          UNION ALL SELECT MIN(created_at) FROM projection_thread_activities
          UNION ALL SELECT MIN(requested_at) FROM projection_turns
          UNION ALL SELECT MIN(created_at) FROM profile_stats_deleted_prompts
          UNION ALL SELECT MIN(created_at) FROM profile_stats_deleted_tokens
        )
      `);
      const firstMs = first?.firstAt ? Date.parse(first.firstAt) : today.fromMs;
      cursor = resolveInboxDay(
        Number.isFinite(firstMs) ? Math.min(firstMs, today.fromMs) : today.fromMs,
      ).fromMs;
    }

    const persistCursor = () =>
      Effect.runPromise(
        writeFileStringAtomically({
          filePath: cursorPath,
          contents: JSON.stringify({ cursor, eventSequence }),
        }),
      );
    // Imports keep their original message/event dates. Scan the durable event
    // sequence, after projection commit, rather than a wall-clock window. A
    // bounded scan and the existing four-day loop also bound repair work.
    const sql = options.sql;
    const [projection] = await Effect.runPromise(sql<{ sequence: number }>`
      SELECT last_applied_sequence AS sequence FROM projection_state WHERE projector = 'projection.hot'
    `);
    const projectedSequence = projection?.sequence ?? 0;
    const messages = await Effect.runPromise(sql<{ sequence: number; createdAt: string }>`
      SELECT sequence, json_extract(payload_json, '$.createdAt') AS createdAt
      FROM orchestration_events
      WHERE sequence > ${eventSequence}
        AND sequence <= ${projectedSequence}
        AND event_type = 'thread.message-sent'
        AND json_extract(payload_json, '$.role') = 'user'
        AND json_extract(payload_json, '$.source') = 'native'
        AND (json_extract(payload_json, '$.dispatchOrigin') IS NULL
          OR json_extract(payload_json, '$.dispatchOrigin') = 'user')
      ORDER BY sequence LIMIT 1000
    `);
    const scannedEvents = projectedSequence > eventSequence;
    for (const message of messages) {
      const createdAt = Date.parse(message.createdAt);
      if (Number.isFinite(createdAt) && createdAt < cursor)
        cursor = resolveInboxDay(createdAt).fromMs;
      eventSequence = message.sequence;
    }
    if (messages.length < 1000) eventSequence = Math.max(eventSequence, projectedSequence);
    // Acknowledge imports and the rewound cursor atomically BEFORE uploading:
    // failed uploads/restarts must still own every historical day to repair.
    if (scannedEvents) await persistCursor();

    const upload = async (fromMs: number, current: boolean) => {
      if (stopped) throw new Error("Inbox sync stopped");
      const range = resolveInboxDay(fromMs);
      const recap = await Effect.runPromise(options.recapQuery.getRecap(recapInputForRange(range)));
      const totals = recap.totals;
      if (
        totals.prompts === 0 &&
        totals.turns === 0 &&
        totals.agentWorkMs === 0 &&
        totals.tokens.user + totals.tokens.automation + totals.tokens.agent === 0
      )
        return;
      const start = new Date(fromMs);
      const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
      const request = Schema.decodeUnknownSync(SaveInboxRecapRequest)({
        sourceHostId: account.hostId,
        day,
        timezone,
        recap,
      });
      const fingerprint = createHash("sha256")
        .update(identity)
        .update(
          JSON.stringify({
            ...request,
            recap: { ...recap, generatedAt: undefined },
          }),
        )
        .digest("hex");
      if (current && fingerprint === lastSnapshot) return;
      await withFreshAccessToken(
        { baseDir: credentialDir, client, expectedIdentity: account },
        async (token) => {
          if (stopped) throw new Error("Inbox sync stopped");
          // The authenticated identity, not editable local account metadata, owns the upload.
          const me = await client.me(token);
          if (me.id !== account.userId || me.organization.id !== account.organizationId)
            throw new Error("Inbox account changed");
          await client.syncInboxRecap(token, request);
        },
      );
      if (current) lastSnapshot = fingerprint;
    };

    await upload(today.fromMs, true);
    for (let count = 0; cursor < today.fromMs && count < 4 && !stopped; count++) {
      await upload(cursor, false);
      cursor = resolveInboxDay(cursor).toMs;
      await persistCursor();
    }
    // Persist an empty installation's starting point too, avoiding a full-history
    // scan every minute and preserving days accumulated while signed out/offline.
    if (!stopped && cursor === today.fromMs) {
      await persistCursor();
    }
  }

  function flushNow(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(timer);
    inFlight = sync()
      .catch(() => {
        // Errors may include recap data or credentials. Never log their payloads.
        Effect.runFork(Effect.logWarning("Private Inbox sync failed; retrying in one minute."));
      })
      .finally(() => {
        inFlight = undefined;
        if (!stopped) {
          timer = setTimeout(() => void flushNow(), 60_000);
          timer.unref();
        }
      });
    return inFlight;
  }
  timer = setTimeout(() => void flushNow(), 5_000);
  timer.unref();
  return {
    flushNow,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
