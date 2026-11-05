import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveInboxRecapRequest } from "@synara/contracts";
import { createAccountInboxReporter } from "./accountInboxReporter";
import { writeAccountCredentials } from "./accountAuth";
import { isServerBetaFeatureEnabled } from "./betaFeatureGate";
import { makeRecapStatsQuery } from "./recapStats";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";

vi.mock("./betaFeatureGate", () => ({ isServerBetaFeatureEnabled: vi.fn(() => true) }));

const account = {
  accountUrl: "https://account.example.test",
  workosClientId: "client_test",
  workosApiUrl: "https://identity.example.test",
  userId: "user_1",
  organizationId: "org_1",
  hostId: "00000000-0000-4000-8000-000000000001",
  hostOwnerUserId: "user_1",
  hostKeyGeneration: 1,
  accessToken: "test-access",
  refreshToken: "test-refresh",
};
const now = new Date(2026, 9, 3, 12).getTime();
const stamp = (day: number) => new Date(2026, 9, day, 8).toISOString();
const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(isServerBetaFeatureEnabled).mockReturnValue(true);
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function run(effect: Effect.Effect<void, unknown, SqlClient.SqlClient>) {
  return effect.pipe(
    Effect.provide(SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer))),
    Effect.scoped,
    Effect.runPromise,
  );
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "synara-inbox-auto-"));
  homes.push(home);
  await writeAccountCredentials(home, account);
  const pushes: SaveInboxRecapRequest[] = [];
  let failDay: string | undefined;
  let failureStatus = 503;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/me"))
      return Response.json({
        id: "user_1",
        name: "Test",
        email: "test@example.test",
        organization: { id: "org_1", name: "Test" },
      });
    expect(url).toBe(`${account.accountUrl}/api/v1/inbox/recaps/sync`);
    expect(init?.method).toBe("POST");
    const request = Schema.decodeUnknownSync(SaveInboxRecapRequest)(JSON.parse(String(init?.body)));
    pushes.push(request);
    if (request.day === failDay)
      return Response.json(
        { error: { code: "internal_error", message: "offline" } },
        { status: failureStatus },
      );
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(Date, "now").mockReturnValue(now);
  return {
    home,
    pushes,
    fetch,
    fail(day?: string, status = 503) {
      failDay = day;
      failureStatus = status;
    },
  };
}

describe("automatic private Inbox history", () => {
  it.each([503, 200])(
    "catches up after restart without advancing on a failed or unacknowledged save (%i)",
    async (status) => {
      const f = await fixture();
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES
        ('one', ${stamp(1)}), ('two', ${stamp(2)}), ('three', ${stamp(3)})`;
          const recapQuery = yield* makeRecapStatsQuery();
          const options = { baseDir: f.home, sql, recapQuery };
          const first = createAccountInboxReporter(options);
          f.fail("2026-10-02", status);
          yield* Effect.promise(() => first.flushNow());
          first.stop();
          expect(f.pushes.map((p) => p.day)).toEqual(["2026-10-03", "2026-10-01", "2026-10-02"]);
          expect(f.pushes.map((p) => p.recap.totals.prompts)).toEqual([1, 1, 1]);
          const [file] = yield* Effect.promise(() => readdir(join(f.home, "inbox-sync")));
          expect(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(f.home, "inbox-sync", file!), "utf8")),
            ).cursor,
          ).toBe(new Date(2026, 9, 2, 4).getTime());
          f.fail();
          const restarted = createAccountInboxReporter(options);
          yield* Effect.promise(() => restarted.flushNow());
          expect(f.pushes.map((p) => p.day)).toEqual([
            "2026-10-03",
            "2026-10-01",
            "2026-10-02",
            "2026-10-03",
            "2026-10-02",
          ]);
          // Unchanged live data is not uploaded twice, but a new prompt updates the same day.
          yield* Effect.promise(() => restarted.flushNow());
          expect(f.pushes).toHaveLength(5);
          yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES ('four', ${stamp(3)})`;
          yield* Effect.promise(() => restarted.flushNow());
          expect(f.pushes.at(-1)?.recap.totals.prompts).toBe(2);
          vi.mocked(Date.now).mockReturnValue(new Date(2026, 9, 4, 12).getTime());
          yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES ('next', ${stamp(4)})`;
          yield* Effect.promise(() => restarted.flushNow());
          restarted.stop();
          expect(f.pushes.slice(-2).map((p) => p.day)).toEqual(["2026-10-04", "2026-10-03"]);
          expect(f.pushes.at(-1)?.recap.totals.prompts).toBe(2);
        }),
      );
    },
  );

  it("repairs a late historical import after failure/restart within the four-day budget and source identity", async () => {
    const f = await fixture();
    vi.mocked(Date.now).mockReturnValue(new Date(2026, 9, 10, 12).getTime());
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const recapQuery = yield* makeRecapStatsQuery();
        const options = { baseDir: f.home, sql, recapQuery };
        const initial = createAccountInboxReporter(options);
        yield* Effect.promise(() => initial.flushNow());
        initial.stop();
        const [file] = yield* Effect.promise(() => readdir(join(f.home, "inbox-sync")));
        const cursorPath = join(f.home, "inbox-sync", file!);
        // Upgrade an already caught-up installation's original numeric cursor.
        yield* Effect.promise(() =>
          writeFile(cursorPath, JSON.stringify(new Date(2026, 9, 10, 4).getTime())),
        );
        yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('import-project', 'Imported project', '/import', '{}', ${stamp(1)}, ${stamp(1)})`;
        yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          env_mode, created_at, updated_at)
        VALUES ('import-thread', 'import-project', 'Imported thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default', 'local', ${stamp(1)}, ${stamp(1)})`;
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, source, created_at, updated_at)
        VALUES ('import-message', 'import-thread', 'user', 'historical prompt', 0, 'native', ${stamp(1)}, ${stamp(1)})`;
        // Import events keep historical occurred_at, not the time they reached this DB.
        const payload = JSON.stringify({
          threadId: "import-thread",
          messageId: "import-message",
          role: "user",
          source: "native",
          createdAt: stamp(1),
        });
        yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json)
        VALUES ('import-event', 'thread', 'import-thread', 1, 'thread.message-sent', ${stamp(1)},
          'project-import:import-thread:history:0:0', 'client', ${payload}, '{}')`;
        yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.hot', 1, ${stamp(1)})`;
        f.fail("2026-10-01");
        const failing = createAccountInboxReporter(options);
        yield* Effect.promise(() => failing.flushNow());
        failing.stop();
        expect(f.pushes.map((p) => [p.day, p.recap.totals.prompts])).toEqual([["2026-10-01", 1]]);
        f.fail();
        const restarted = createAccountInboxReporter(options);
        yield* Effect.promise(() => restarted.flushNow());
        restarted.stop();
        expect(f.pushes.map((p) => [p.day, p.recap.totals.prompts])).toEqual([
          ["2026-10-01", 1],
          ["2026-10-01", 1],
        ]);
        const saved = JSON.parse(yield* Effect.promise(() => readFile(cursorPath, "utf8")));
        expect(saved.cursor).toBe(new Date(2026, 9, 5, 4).getTime());
        // Reusing the machine under another source identity gets independent catch-up.
        const otherHost = "00000000-0000-4000-8000-000000000002";
        yield* Effect.promise(() =>
          writeAccountCredentials(f.home, { ...account, hostId: otherHost }),
        );
        const other = createAccountInboxReporter(options);
        yield* Effect.promise(() => other.flushNow());
        other.stop();
        expect(f.pushes.at(-1)?.sourceHostId).toBe(otherHost);
        expect(f.pushes.at(-1)?.recap.totals.prompts).toBe(1);
        expect(yield* Effect.promise(() => readdir(join(f.home, "inbox-sync")))).toHaveLength(2);
      }),
    );
  });

  it("runs without a UI, remains inert on Stable or signed out, and stops its timer", async () => {
    const f = await fixture();
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES ('one', ${stamp(3)})`;
        const recapQuery = yield* makeRecapStatsQuery();
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const reporter = createAccountInboxReporter({ baseDir: f.home, sql, recapQuery });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5_000));
        // Wait for the timer's own upload before joining it; a manual flush must
        // not make this test pass if automatic scheduling is accidentally removed.
        yield* Effect.promise(() => vi.waitFor(() => expect(f.pushes).toHaveLength(1)));
        yield* Effect.promise(() => reporter.flushNow());
        expect(f.pushes).toHaveLength(1);
        vi.mocked(isServerBetaFeatureEnabled).mockReturnValue(false);
        yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES ('two', ${stamp(3)})`;
        yield* Effect.promise(() => reporter.flushNow());
        expect(f.pushes).toHaveLength(1);
        vi.mocked(isServerBetaFeatureEnabled).mockReturnValue(true);
        const { accessToken: _accessToken, refreshToken: _refreshToken, ...signedOut } = account;
        yield* Effect.promise(() => writeAccountCredentials(f.home, signedOut));
        yield* Effect.promise(() => reporter.flushNow());
        expect(f.pushes).toHaveLength(1);
        reporter.stop();
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(120_000));
        expect(f.pushes).toHaveLength(1);
      }),
    );
  });
});
