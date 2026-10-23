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
