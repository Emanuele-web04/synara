import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";
import { jwtVerify, importJWK } from "jose";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { writeAccountCredentials } from "./accountAuth";
import { generateAndPersistHostIdentity } from "./hostIdentity";
import { createAccountLiveActivityReporter } from "./accountLiveActivityReporter";

vi.mock("./betaFeatureGate", () => ({ isServerBetaFeatureEnabled: () => true }));

it.each([
  ["completed", null, "ready"],
  ["running", "approval", "needsApproval"],
  ["running", "userInput", "needsInput"],
] as const)(
  "reports subscribed %s/%s turns with host proof and no chat content",
  async (state, interaction, expected) => {
    const home = await mkdtemp(join(tmpdir(), "synara-activity-reporter-"));
    const identityPath = join(home, "secrets", "host-identity.json");
    const identity = await generateAndPersistHostIdentity(identityPath);
    const account = {
      accountUrl: "https://account.example.test",
      workosClientId: "test",
      workosApiUrl: "https://identity.example.test",
      userId: "user",
      organizationId: "org",
      hostId: "00000000-0000-4000-8000-000000000001",
      hostOwnerUserId: "user",
      hostKeyGeneration: 1,
      accessToken: "test-access",
      refreshToken: "test-refresh",
    };
    await writeAccountCredentials(home, account);
    const sent: unknown[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${account.accountUrl}/api/v1/hosts/${account.hostId}/live-activities`);
      const proof = String(new Headers(init?.headers).get("authorization")).slice(10);
      await jwtVerify(proof, await importJWK(identity.publicKeyJwk, "EdDSA"), {
        audience: `${account.accountUrl}/api/v1`,
        subject: account.hostId,
      });
      if (init?.method === "PUT") {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      return Response.json({ turns: [{ threadId: "watched", turnId: "turn-1" }] });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,started_at,checkpoint_files_json)
        VALUES ('watched','turn-1',${state},'2026-10-09T10:00:00.000Z','2026-10-09T10:00:00.000Z','[]'),
        ('private','turn-2','running','2026-10-09T10:00:00.000Z','2026-10-09T10:00:00.000Z','[]')`;
            if (interaction)
              yield* sql`INSERT INTO projection_pending_interactions
            (interaction_kind,request_id,thread_id,turn_id,status,created_at)
            VALUES (${interaction},'request','watched','turn-1','pending','2026-10-09T10:00:00.000Z')`;
            const reporter = createAccountLiveActivityReporter({
              baseDir: home,
              hostIdentityPath: identityPath,
              sql,
            });
            try {
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 }),
              );
              expect(sent[0]).toMatchObject({
                turns: [
                  { threadId: "watched", turnId: "turn-1", state: expected, startedAt: 1791540000 },
                ],
              });
              expect(JSON.stringify(sent)).not.toContain("private");
            } finally {
              reporter.stop();
            }
          }).pipe(Effect.provide(SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer)))),
        ),
      );
    } finally {
      vi.unstubAllGlobals();
      await rm(home, { recursive: true, force: true });
    }
  },
);

const quotaReset = "2026-11-01T10:00:00.000Z";
const link = (turnId: string, resumedTurnId?: string) => ({
  id: `quota-${turnId}`,
  turnId,
  resetAt: quotaReset,
  autoResume: true as const,
  state: resumedTurnId ? ("resuming" as const) : ("waiting" as const),
  ...(resumedTurnId ? { resumedTurnId } : {}),
});
const recoveryCases = [
  {
    name: "waiting",
    current: link("source"),
    expected: { state: "usageLimit", usageLimitResetAt: Date.parse(quotaReset) / 1_000 },
  },
  {
    name: "admitted without provider turn",
    current: { ...link("source"), state: "resuming" },
    expected: { state: "resuming" },
  },
  {
    name: "admitted id before projection turn exists",
    current: link("source", "resumed"),
    expected: { state: "resuming", effectiveTurnId: "resumed" },
  },
  {
    name: "running recorded continuation",
    current: link("source", "resumed"),
    resumedState: "running",
    expected: { state: "running", effectiveTurnId: "resumed", startedAt: 1791540060 },
  },
  {
    name: "fast completion between polls",
    history: [link("source", "resumed")],
    resumedState: "completed",
    expected: { state: "ready", effectiveTurnId: "resumed", startedAt: 1791540060 },
  },
  {
    name: "cancelled wait",
    history: [link("source")],
    cancelled: "source",
    expected: { state: "stopped" },
  },
  { name: "unrelated new human turn", history: [link("source")], expected: { state: "stopped" } },
  {
    name: "late cancellation of admitted turn",
    history: [link("source", "resumed")],
    resumedState: "error",
    cancelled: "resumed",
    expected: { state: "stopped" },
  },
  {
    name: "two recorded quota continuations",
    history: [link("source", "resumed"), link("resumed", "final")],
    resumedState: "error",
    finalState: "completed",
    expected: { state: "ready", effectiveTurnId: "final", startedAt: 1791540120 },
  },
  {
    name: "cyclic recovery history",
    history: [link("source", "resumed"), link("resumed", "source")],
    resumedState: "error",
    expected: { state: "stopped" },
  },
  {
    name: "ordinary completion before an unrelated human turn",
    sourceState: "completed",
    cancelled: "source",
    expected: { state: "ready", startedAt: 1791540000 },
  },
  { name: "more than 64 recorded continuations", longChain: true, expected: { state: "stopped" } },
  {
    name: "malformed historical recovery",
    history: [{ ...link("source"), autoResume: false }],
    expected: { state: "stopped" },
  },
  {
    name: "terminal ingestion still pending",
    pendingTerminal: true,
    expected: { state: "resuming" },
  },
  {
    name: "ordinary acknowledged failure",
    pendingTerminal: true,
    acknowledged: true,
    expected: { state: "failed", startedAt: 1791540000 },
  },
] as const;

it.each(recoveryCases)(
  "keeps an original killed-phone watch exact through $name",
  async (scenario) => {
    const home = await mkdtemp(join(tmpdir(), "synara-quota-activity-"));
    const identityPath = join(home, "host-identity.json");
    await generateAndPersistHostIdentity(identityPath);
    await writeAccountCredentials(home, {
      accountUrl: "https://account.example.test",
      workosClientId: "test",
      workosApiUrl: "https://identity.example.test",
      userId: "user",
      organizationId: "org",
      hostId: "00000000-0000-4000-8000-000000000001",
      hostOwnerUserId: "user",
      hostKeyGeneration: 1,
      accessToken: "test-access",
      refreshToken: "test-refresh",
    });
    const sent: Array<{ turns: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          sent.push(JSON.parse(String(init.body)));
          return Response.json({ ok: true });
        }
        return Response.json({ turns: [{ threadId: "watched", turnId: "source" }] });
      }),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const migration = yield* sql<{ id: number }>`SELECT migration_id AS id
              FROM effect_sql_migrations WHERE migration_id=141`;
            expect(migration).toEqual([{ id: 141 }]);
            const current = "current" in scenario ? JSON.stringify(scenario.current) : null;
            const cancelled = "cancelled" in scenario ? scenario.cancelled : null;
            yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at,usage_limit_recovery_json,usage_limit_recovery_cancelled_turn_id)
        VALUES ('watched','project','PRIVATE TITLE','2026-10-09T10:00:00.000Z','2026-10-09T10:00:00.000Z',${current},${cancelled})`;
            yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,started_at,checkpoint_files_json)
        VALUES ('watched','source',${"sourceState" in scenario ? scenario.sourceState : "error"},'2026-10-09T10:00:00.000Z','2026-10-09T10:00:00.000Z','[]'),
        ('watched','unrelated-human','running','2026-10-09T10:03:00.000Z','2026-10-09T10:03:00.000Z','[]')`;
            if ("resumedState" in scenario)
              yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,started_at,checkpoint_files_json)
        VALUES ('watched','resumed',${scenario.resumedState},'2026-10-09T10:01:00.000Z','2026-10-09T10:01:00.000Z','[]')`;
            if ("finalState" in scenario)
              yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,started_at,checkpoint_files_json)
        VALUES ('watched','final',${scenario.finalState},'2026-10-09T10:02:00.000Z','2026-10-09T10:02:00.000Z','[]')`;
            if ("longChain" in scenario)
              for (let step = 1; step <= 65; step++) {
                yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,started_at,checkpoint_files_json)
                VALUES ('watched',${`chain-${step}`},'error','2026-10-09T10:00:00.000Z','2026-10-09T10:00:00.000Z','[]')`;
              }
            const history =
              "longChain" in scenario
                ? Array.from({ length: 65 }, (_, step) =>
                    link(step === 0 ? "source" : `chain-${step}`, `chain-${step + 1}`),
                  )
                : "history" in scenario
                  ? scenario.history
                  : [];
            let sequence = 0;
            for (const recovery of history) {
              sequence += 1;
              yield* sql`INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
          VALUES (${sequence},${`event-${sequence}`},'thread','watched',${sequence},'thread.meta-updated','2026-10-09T10:01:00.000Z','system',${JSON.stringify({ usageLimitRecovery: recovery })},'{}')`;
            }
            yield* sql`INSERT INTO projection_state(projector,last_applied_sequence,updated_at)
        VALUES ('projection.hot',${sequence},'2026-10-09T10:02:00.000Z')
        ON CONFLICT(projector) DO UPDATE SET last_applied_sequence=${sequence}`;
            if ("pendingTerminal" in scenario) {
              yield* sql`INSERT INTO provider_runtime_events(sequence,event_id,thread_id,turn_id,event_type,event_json,persisted_at)
          VALUES (1,'terminal-source','watched','source','turn.completed','{}','2026-10-09T10:00:00.000Z')`;
              if ("acknowledged" in scenario)
                yield* sql`UPDATE provider_runtime_event_consumers SET last_acked_sequence=1 WHERE consumer_name='provider-runtime-ingestion.v1'`;
            }
            const plan = yield* sql<{
              detail: string;
            }>`EXPLAIN QUERY PLAN SELECT sequence FROM orchestration_events
        WHERE aggregate_kind='thread' AND event_type='thread.meta-updated'
          AND json_type(payload_json,'$.usageLimitRecovery')='object'
          AND stream_id='watched' AND json_extract(payload_json,'$.usageLimitRecovery.turnId')='source'
          AND sequence<=${sequence} ORDER BY sequence DESC LIMIT 1`;
            expect(
              plan.some((row) => row.detail.includes("idx_orch_usage_limit_recovery_source")),
            ).toBe(true);
            const reporter = createAccountLiveActivityReporter({
              baseDir: home,
              hostIdentityPath: identityPath,
              sql,
            });
            try {
              yield* Effect.promise(() =>
                vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5000 }),
              );
              expect(sent[0]?.turns).toEqual([
                { threadId: "watched", turnId: "source", ...scenario.expected },
              ]);
              expect(JSON.stringify(sent)).not.toContain("PRIVATE TITLE");
              if (["usageLimit", "resuming", "stopped"].includes(scenario.expected.state))
                expect(sent[0]?.turns[0]).not.toHaveProperty("startedAt");
            } finally {
              reporter.stop();
            }
          }).pipe(Effect.provide(SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer)))),
        ),
      );
    } finally {
      vi.unstubAllGlobals();
      await rm(home, { recursive: true, force: true });
    }
  },
);
