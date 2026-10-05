import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventId, ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { ServerConfig } from "./config.ts";
import { CodexAppServerManager } from "./codexAppServerManager.ts";
import {
  prepareCodexAuthTracking,
  readCodexPreparedAuthTrackingFingerprint,
} from "./codexProcessEnv.ts";
import { CodexAdapter } from "./provider/Services/CodexAdapter.ts";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const auth = (account: string, token: string) =>
  JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account, access_token: token } });

function fixture() {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-async-inspection-"));
  roots.push(homePath);
  const authPath = path.join(homePath, "auth.json");
  fs.writeFileSync(authPath, auth("first", "old-token"));
  const codexOptions = { homePath };
  const authTracking = prepareCodexAuthTracking(codexOptions);
  const threadId = ThreadId.makeUnsafe("async-inspection");
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      providerInstanceId: "codex_work",
      threadId,
      status: "ready",
      runtimeMode: "full-access",
    },
    child: {
      exitCode: null,
      signalCode: null,
      killed: false,
      stdin: { writable: true, writableEnded: false, destroyed: false },
    },
    codexOptions,
    authTracking,
    authFingerprint: readCodexPreparedAuthTrackingFingerprint(authTracking),
    lifecycleGeneration: "original-generation",
    teardownFailed: false,
  };
  const sessions = (manager as unknown as { sessions: Map<ThreadId, unknown> }).sessions;
  sessions.set(threadId, context);
  const stop = vi.spyOn(manager, "stopSession").mockResolvedValue();
  return { manager, context, sessions, threadId, authPath, auth, stop };
}

it("preserves same-account token rotation and stops an account change asynchronously", async () => {
  const { manager, threadId, authPath, auth, stop } = fixture();
  fs.writeFileSync(authPath, auth("first", "new-token"));
  await expect(manager.inspectSessionAsync(threadId, "original-generation")).resolves.toMatchObject(
    { session: { providerInstanceId: "codex_work" } },
  );
  expect(stop).not.toHaveBeenCalled();
  fs.writeFileSync(authPath, auth("second", "new-token"));
  await expect(manager.inspectSessionAsync(threadId, "original-generation")).rejects.toThrow(
    "authentication changed",
  );
  expect(stop).toHaveBeenCalledWith(threadId);
});

it("binds queued events to their original context even without a generation tag", async () => {
  const { manager, context, sessions, threadId, stop } = fixture();
  const origin = manager.getSessionEventOrigin(threadId);
  sessions.set(threadId, {
    ...context,
    session: { ...context.session, providerInstanceId: "codex_personal" },
  });
  expect(origin.providerInstanceId).toBe("codex_work");
  await expect(origin.inspect()).resolves.toBeUndefined();
  expect(stop).not.toHaveBeenCalled();
});

it.each(["hasSession", "listSessions"] as const)(
  "fences queued origins when synchronous %s prunes stale auth",
  async (operation) => {
    const { manager, sessions, threadId, authPath, auth, stop } = fixture();
    const origin = manager.getSessionEventOrigin(threadId);
    stop.mockImplementation(async (id) => {
      sessions.delete(id);
    });
    fs.writeFileSync(authPath, auth("changed-account", "new-token"));
    if (operation === "hasSession") expect(manager.hasSession(threadId)).toBe(false);
    else expect(manager.listSessions()).toEqual([]);
    expect(origin.isAuthRejected()).toBe(true);
    await expect(origin.inspect()).rejects.toThrow("authentication changed");
    expect(stop).toHaveBeenCalledOnce();
  },
);

it("retries failed stale-auth teardown during later lifecycle listing", () => {
  const { manager, context, authPath, auth, stop } = fixture();
  fs.writeFileSync(authPath, auth("changed-account", "new-token"));
  manager.listSessions();
  expect(stop).toHaveBeenCalledOnce();
  // A failed process-tree exit proof retains the closed context as a barrier.
  context.teardownFailed = true;
  manager.listSessions();
  expect(stop).toHaveBeenCalledTimes(2);
  context.teardownFailed = false;
  manager.listSessions();
  expect(stop).toHaveBeenCalledTimes(2);
});

it("does not inspect or stop a replacement session after filesystem awaits", async () => {
  const { manager, context, sessions, threadId, stop } = fixture();
  let started!: () => void;
  let release!: () => void;
  const opening = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realpath = fs.promises.realpath.bind(fs.promises);
  vi.spyOn(fs.promises, "realpath").mockImplementationOnce(async (file) => {
    started();
    await gate;
    return realpath(file);
  });
  const inspection = manager.getSessionEventOrigin(threadId).inspect();
  await opening;
  sessions.set(threadId, {
    ...context,
    session: { ...context.session, providerInstanceId: "codex_personal" },
  });
  release();
  await expect(inspection).resolves.toBeUndefined();
  expect(stop).not.toHaveBeenCalled();
});

it("suppresses already stamped custom-account output when async auth validation fails", async () => {
  const { manager, context, sessions, threadId, authPath, auth, stop } = fixture();
  const sentinelThread = ThreadId.makeUnsafe("sentinel-session");
  sessions.set(sentinelThread, {
    ...context,
    authTracking: undefined,
    authFingerprint: undefined,
    session: { ...context.session, threadId: sentinelThread },
  });
  fs.writeFileSync(authPath, auth("different-account", "new-token"));
  stop.mockImplementation(async (id) => {
    manager.emit("event", {
      id: EventId.makeUnsafe("manager-stale-close"),
      kind: "session",
      provider: "codex",
      providerInstanceId: "codex_work",
      threadId: id,
      method: "session/closed",
      createdAt: new Date().toISOString(),
      message: "Session stopped",
    });
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const collected = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(2))).pipe(
          Effect.forkChild,
        );
        for (const id of ["stale-one", "stale-two", "sentinel"])
          manager.emit("event", {
            id: EventId.makeUnsafe(id),
            kind: id === "sentinel" ? "session" : "notification",
            provider: "codex",
            threadId: id === "sentinel" ? sentinelThread : threadId,
            createdAt: new Date().toISOString(),
            method: id === "sentinel" ? "session/closed" : "item/agentMessage/delta",
            payload: { itemId: "fixture-assistant", delta: "Stale account output" },
            message: "Session stopped",
          });
        const result = yield* Fiber.join(collected);
        expect(result.map((event) => event.type)).toEqual(["session.exited", "session.exited"]);
        expect(result.map((event) => event.threadId)).toEqual([sentinelThread, threadId]);
        expect(result[1]?.providerInstanceId).toBe("codex_work");
        expect(stop).toHaveBeenCalledOnce();
      }),
    ).pipe(
      Effect.provide(makeCodexAdapterLive({ manager })),
      Effect.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Effect.provide(NodeServices.layer),
    ),
  );
});

it("suppresses a completed preparation invalidated by an earlier delayed reader", async () => {
  const { manager, context, sessions, threadId, authPath, auth } = fixture();
  const sentinelThread = ThreadId.makeUnsafe("valid-sentinel");
  sessions.set(sentinelThread, {
    ...context,
    authTracking: undefined,
    authFingerprint: undefined,
    session: { ...context.session, threadId: sentinelThread },
  });
  let release!: () => void;
  let prepared!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const laterPrepared = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const inspect = manager.inspectSessionAsync.bind(manager);
  let calls = 0;
  vi.spyOn(manager, "inspectSessionAsync").mockImplementation(async (id, generation) => {
    if (id !== threadId) return inspect(id, generation);
    const call = ++calls;
    if (call === 1) await gate;
    const result = await inspect(id, generation);
    if (call === 2) prepared();
    return result;
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const collected = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        for (const id of ["delayed", "prepared", "sentinel"])
          manager.emit("event", {
            id: EventId.makeUnsafe(id),
            kind: id === "sentinel" ? "session" : "notification",
            provider: "codex",
            threadId: id === "sentinel" ? sentinelThread : threadId,
            createdAt: new Date().toISOString(),
            method: id === "sentinel" ? "session/closed" : "item/agentMessage/delta",
            payload: { itemId: "fixture-assistant", delta: "Stale account output" },
            message: "Session stopped",
          });
        yield* Effect.promise(() => laterPrepared);
        fs.writeFileSync(authPath, auth("changed-after-preparation", "new-token"));
        release();
        const result = yield* Fiber.join(collected);
        expect(result._tag).toBe("Some");
        if (result._tag === "Some") expect(result.value.threadId).toBe(sentinelThread);
      }),
    ).pipe(
      Effect.provide(makeCodexAdapterLive({ manager })),
      Effect.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Effect.provide(NodeServices.layer),
    ),
  );
});
