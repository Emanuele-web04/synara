import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { createBillingService } from "../billing/service";
import { createLiveActivityService } from "../liveActivities/service";
import { startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import { createDb, POOL_CONNECTION_TIMEOUT_MS } from "./index";

/**
 * A database that accepts TCP connections and never answers: every pooled
 * acquisition must give up after the connection timeout. No PostgreSQL needed.
 */
let silent: Server;
const sockets = new Set<Socket>();
let databaseUrl: string;

beforeAll(async () => {
  silent = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  if (!address || typeof address === "string") throw new Error("no port");
  databaseUrl = `postgres://synthetic:synthetic-secret@127.0.0.1:${address.port}/synara`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Settles `pending` by advancing fake time past the acquire timeout. */
async function afterAcquireTimeout<T>(pending: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([pending]).then(([result]) => result!);
  await vi.advanceTimersByTimeAsync(POOL_CONNECTION_TIMEOUT_MS + 100);
  return settled;
}

function expectAcquireTimeout(result: PromiseSettledResult<unknown>) {
  expect(result.status).toBe("rejected");
  const reason = (result as PromiseRejectedResult).reason as Error;
  // A TypeError here would mean ROLLBACK or release ran on a client never acquired.
  expect(reason).not.toBeInstanceOf(TypeError);
  expect(reason.message).toMatch(/timeout/i);
}

describe("database pool connection acquire timeout", () => {
  it("bounds acquisition below the client's 15 s timeout and changes nothing else", () => {
    const { pool } = createDb(databaseUrl);
    expect(POOL_CONNECTION_TIMEOUT_MS).toBeLessThan(15_000);
    expect(pool.options).toMatchObject({ connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS });
    expect(pool.options.max).toBe(10);
    expect(pool.options).not.toHaveProperty("statement_timeout");
    expect(pool.options).not.toHaveProperty("query_timeout");
  });

  it("fails a Drizzle transaction without running it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { db, pool } = createDb(databaseUrl);
    const body = vi.fn();
    expectAcquireTimeout(await afterAcquireTimeout(db.transaction(body)));
    expect(body).not.toHaveBeenCalled();
    expect(pool.totalCount).toBe(0);
  });

  it("fails the live-activity transaction before ROLLBACK or release", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { pool } = createDb(databaseUrl);
    const service = createLiveActivityService({
      pool,
      environment: "sandbox",
      send: async () => "delivered",
      isMember: async () => true,
    });
    const owner = { userId: "user_1", orgId: "org_1", sessionId: "session_1" };
    const request = {
      activityId: randomUUID(),
      deviceJkt: randomUUID(),
      revision: 1,
      token: "a".repeat(64),
      environment: "sandbox" as const,
      sources: [
        {
          hostId: randomUUID(),
          threadId: randomUUID(),
          turnId: randomUUID(),
          displayId: randomUUID(),
        },
      ],
    };
    expectAcquireTimeout(await afterAcquireTimeout(service.register(owner, request)));
    expect(pool.totalCount).toBe(0);
  });

  it("fails the billing ledger lock before ROLLBACK or release", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { pool } = createDb(databaseUrl);
    // Statements outside the lock answer; only the locked path needs a client.
    vi.spyOn(pool, "query").mockImplementation((async () => ({
      rows: [
        {
          environment: "sandbox",
          present: false,
          deleting: false,
          pending_webhook: false,
          product_ids: null,
          checked_at: null,
          checkout_attempt_id: null,
          checkout_product_id: null,
          deleted_at: null,
        },
      ],
    })) as never);
    const state = vi.fn(async () => null);
    const billing = createBillingService({
      pool,
      provider: { environment: "sandbox", state } as unknown as Parameters<
        typeof createBillingService
      >[0]["provider"],
    });
    expectAcquireTimeout(await afterAcquireTimeout(billing.access("user_1")));
    expect(state).toHaveBeenCalledTimes(1);
    expect(pool.totalCount).toBe(0);
  });

  describe("through the API", () => {
    let workos: FakeWorkos;
    beforeAll(async () => {
      workos = await startFakeWorkos();
    });
    afterAll(async () => {
      await workos.close();
    });

    it("answers a signed-in request with the retryable JSON 500, never a credential refusal", async () => {
      const { app, pool } = await createApp(workos.config({ databaseUrl }));
      const user = workos.addUser({});
      const token = await workos.signAccessToken({ sub: user.id, sid: randomUUID() });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = Promise.resolve(
        app.request("/api/v1/me", { headers: { authorization: `Bearer ${token}` } }),
      );
      // The token is verified over real HTTP first; keep advancing until the
      // session fence's database read gives up.
      let response: Response | undefined;
      for (let step = 0; step < 50; step += 1) {
        await vi.advanceTimersByTimeAsync(POOL_CONNECTION_TIMEOUT_MS / 5);
        // An already settled `pending` wins the race; otherwise keep advancing.
        response = await Promise.race([pending, Promise.resolve(undefined)]);
        if (response) break;
      }
      vi.useRealTimers();
      response ??= await pending;
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        error: "internal_error",
        message: "Something went wrong handling this request",
      });
      expect(body).not.toContain("synthetic-secret");
      expect(log.mock.calls.flat().join(" ")).not.toContain("synthetic-secret");
      await pool.end();
    });
  });
});
