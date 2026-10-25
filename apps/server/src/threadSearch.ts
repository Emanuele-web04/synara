// FILE: threadSearch.ts
// Purpose: Message-content search over persisted chat history for the sidebar palette.
// The web client only keeps message bodies for recently opened threads, so this
// read covers every live thread regardless of what a client has hydrated.
// Layer: server read query service (SqlClient). Available in Stable and Beta.

import {
  ORCHESTRATION_SEARCH_THREADS_MAX_EXCERPT_LENGTH,
  ORCHESTRATION_SEARCH_THREADS_MAX_LIMIT,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type PersistenceSqlError, toPersistenceSqlError } from "./persistence/Errors.ts";

const DEFAULT_LIMIT = 20;
// The RPC schema bounds the whole query to 200 characters; never discard
// words here because every distinct token must match.
const EXCERPT_CONTEXT_BEFORE = 80;
const ELLIPSIS = "...";

interface SearchRow {
  readonly threadId: string;
  readonly body: string;
  readonly matchCount: number;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

export function tokenizeThreadSearchQuery(query: string): string[] {
  const tokens = normalizeWhitespace(query)
    .toLowerCase()
    .split(" ")
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

/** A window around the phrase (or earliest token) so the client can build its own snippet. */
export function buildThreadSearchExcerpt(
  text: string,
  query: string,
  tokens: readonly string[],
): string {
  const display = normalizeWhitespace(text);
  const maxBody = ORCHESTRATION_SEARCH_THREADS_MAX_EXCERPT_LENGTH - ELLIPSIS.length * 2;
  if (display.length <= ORCHESTRATION_SEARCH_THREADS_MAX_EXCERPT_LENGTH) {
    return display;
  }
  const lower = display.toLowerCase();
  let hitIndex = lower.indexOf(normalizeWhitespace(query).toLowerCase());
  if (hitIndex < 0) {
    const tokenIndexes = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
    hitIndex = tokenIndexes.length > 0 ? Math.min(...tokenIndexes) : 0;
  }
  const start = Math.min(
    Math.max(0, hitIndex - EXCERPT_CONTEXT_BEFORE),
    Math.max(0, display.length - maxBody),
  );
  const end = Math.min(display.length, start + maxBody);
  const prefix = start > 0 ? ELLIPSIS : "";
  const suffix = end < display.length ? ELLIPSIS : "";
  return `${prefix}${display.slice(start, end).trim()}${suffix}`;
}

export interface ThreadSearchQueryShape {
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, PersistenceSqlError>;
}

export class ThreadSearchQuery extends ServiceMap.Service<
  ThreadSearchQuery,
  ThreadSearchQueryShape
>()("synara/threadSearch/ThreadSearchQuery") {}

export const makeThreadSearchQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const searchThreads: ThreadSearchQueryShape["searchThreads"] = (input) =>
    Effect.gen(function* () {
      const tokens = tokenizeThreadSearchQuery(input.query);
      if (tokens.length === 0) {
        return { matches: [] };
      }
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, ORCHESTRATION_SEARCH_THREADS_MAX_LIMIT);
      // Settled bodies live in `text`, or JSON-encoded in `text_json` when they
      // carry NULs or lone surrogates; streaming rows are skipped.
      // Literal substring matching avoids wildcard interpretation and LIKE's
      // truncation at NUL in decoded persisted bodies. SQLite lower remains
      // ASCII-only, matching the existing search case-folding contract.
      const tokenPredicates = sql.join(
        " AND ",
        false,
      )(
        tokens.map(
          (token) =>
            sql`instr(lower(COALESCE(json_extract(messages.text_json, '$'), messages.text)), ${token}) > 0`,
        ),
      );
      // One row per thread: its best user hit (else assistant), newest first.
      const rows = yield* sql<SearchRow>`
        WITH hits AS (
          SELECT
            messages.thread_id,
            messages.message_id,
            messages.role,
            messages.created_at,
            COALESCE(json_extract(messages.text_json, '$'), messages.text) AS body,
            threads.updated_at AS thread_updated_at
          FROM projection_thread_messages AS messages
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = messages.thread_id
          INNER JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE threads.deleted_at IS NULL
            AND threads.archived_at IS NULL
            AND threads.parent_thread_id IS NULL
            AND projects.deleted_at IS NULL
            AND messages.is_streaming = 0
            AND messages.role IN ('user', 'assistant')
            AND ${tokenPredicates}
        ),
        ranked AS (
          SELECT
            thread_id,
            body,
            thread_updated_at,
            COUNT(*) OVER (PARTITION BY thread_id) AS match_count,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY CASE role WHEN 'user' THEN 0 ELSE 1 END, created_at DESC, message_id
            ) AS thread_rank
          FROM hits
        )
        SELECT thread_id AS "threadId", body, match_count AS "matchCount"
        FROM ranked
        WHERE thread_rank = 1
        ORDER BY thread_updated_at DESC, thread_id
        LIMIT ${limit}
      `.pipe(Effect.mapError(toPersistenceSqlError("ThreadSearchQuery.searchThreads")));

      return {
        matches: rows.map((row) => ({
          threadId: ThreadId.makeUnsafe(row.threadId),
          excerpt: buildThreadSearchExcerpt(row.body, input.query, tokens),
          matchCount: row.matchCount,
        })),
      };
    });

  return { searchThreads } satisfies ThreadSearchQueryShape;
});

export const ThreadSearchQueryLive = Layer.effect(ThreadSearchQuery, makeThreadSearchQuery);
