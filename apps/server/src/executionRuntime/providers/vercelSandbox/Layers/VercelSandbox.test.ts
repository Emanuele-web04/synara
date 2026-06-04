import { existsSync } from "node:fs";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { type RuntimePlan } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { VercelSandboxAdapter } from "../Services/VercelSandboxAdapter.ts";
import { VercelSandboxClient } from "../Services/VercelSandboxClient.ts";
import { FakeVercelSandboxClientLive } from "./FakeVercelSandboxClient.ts";
import {
  hasVercelSandboxCredentials,
  VERCEL_SANDBOX_CREDENTIAL_ENV,
} from "./VercelSandboxClientLive.ts";
import { VercelSandboxAdapterLive } from "./VercelSandboxAdapter.ts";

const makeRuntime = () => {
  // The client is exposed alongside the adapter so the snapshot/restore test can
  // drive the file API directly.
  const layer = Layer.mergeAll(
    VercelSandboxAdapterLive.pipe(Layer.provide(FakeVercelSandboxClientLive)),
    FakeVercelSandboxClientLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return ManagedRuntime.make(layer);
};

type TestRuntime = ReturnType<typeof makeRuntime>;

const planWithPorts = (
  ports: ReadonlyArray<number>,
  snapshotId: string | null = null,
): RuntimePlan => ({
  targetKind: "remote-runtime",
  provider: "vercel-sandbox",
  ports,
  persistent: false,
  snapshotId: snapshotId === null ? null : (snapshotId as RuntimePlan["snapshotId"]),
});

describe("VercelSandboxAdapter (fake-backed)", () => {
  let runtime: TestRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("declares ports at create and yields a preview URL per declared port", async () => {
    runtime = makeRuntime();
    const local = runtime;
    const result = await local.runPromise(
      Effect.gen(function* () {
        const adapter = yield* VercelSandboxAdapter;
        const context = yield* adapter.provision({
          threadId: "thread-ports",
          plan: planWithPorts([3000, 8080]),
        });
        const route3000 = yield* adapter.exposePort(context.instance.id, 3000);
        const url3000 = route3000.url ?? "";
        const undeclared = yield* adapter.exposePort(context.instance.id, 9999).pipe(Effect.exit);
        yield* adapter.destroy(context.instance.id);
        return { context, url3000, undeclared };
      }),
    );

    expect(result.context.routes.map((route) => route.port).toSorted()).toEqual([3000, 8080]);
    for (const route of result.context.routes) {
      expect(route.url).toMatch(/^https:\/\//);
    }
    expect(result.url3000).toMatch(/^https:\/\//);
    // A port never declared at create cannot be exposed on demand.
    expect(result.undeclared._tag).toBe("Failure");
  });

  it("runs the agent as a streaming command and frames its stdout as JSON-RPC inbound", async () => {
    runtime = makeRuntime();
    const local = runtime;
    const lines = await local.runPromise(
      Effect.gen(function* () {
        const adapter = yield* VercelSandboxAdapter;
        const context = yield* adapter.provision({
          threadId: "thread-stream",
          plan: planWithPorts([]),
        });
        const built = yield* adapter.createTransport(context.instance.id, {
          command: "node",
          args: ["-e", "console.log('frame-1'); console.log('frame-2')"],
          cwd: ".",
          env: {},
        });
        // The detached command's stdout lines arrive as inbound transport frames;
        // collect them until the command exits and the stream ends.
        const collected = yield* Stream.runCollect(built.transport.inbound);
        yield* adapter.destroy(context.instance.id);
        return Array.from(collected);
      }),
    );
    expect(lines).toContain("frame-1");
    expect(lines).toContain("frame-2");
  });

  it("snapshots, then restores the snapshot into a fresh sandbox", async () => {
    runtime = makeRuntime();
    const local = runtime;
    const restoredRoot = await local.runPromise(
      Effect.gen(function* () {
        const adapter = yield* VercelSandboxAdapter;
        const client = yield* VercelSandboxClient;

        const first = yield* adapter.provision({
          threadId: "thread-snap",
          plan: planWithPorts([]),
        });
        // Seed a file via the client's file API, then snapshot.
        const created = yield* client.create({
          ports: [],
          timeoutSeconds: 600,
          snapshotId: null,
        });
        yield* client.writeFile(created.sandboxId, "seed.txt", new TextEncoder().encode("payload"));
        const snapshotId = yield* client.snapshot(created.sandboxId);

        // A fresh sandbox restored from the snapshot must carry the seeded file.
        const restored = yield* client.create({
          ports: [],
          timeoutSeconds: 600,
          snapshotId,
        });
        yield* adapter.destroy(first.instance.id);
        return restored.rootPath;
      }),
    );
    expect(existsSync(nodePath.join(restoredRoot, "seed.txt"))).toBe(true);
  });

  it("extends the sandbox timeout via the keepalive", async () => {
    runtime = makeRuntime();
    const local = runtime;
    await local.runPromise(
      Effect.gen(function* () {
        const adapter = yield* VercelSandboxAdapter;
        const context = yield* adapter.provision({
          threadId: "thread-timeout",
          plan: planWithPorts([]),
        });
        yield* adapter.extendTimeout(context.instance.id);
        const alive = yield* adapter.isAlive(context.instance.id);
        expect(alive).toBe(true);
        yield* adapter.destroy(context.instance.id);
        const gone = yield* adapter.isAlive(context.instance.id);
        expect(gone).toBe(false);
      }),
    );
  });

  it("treats the filesystem as ephemeral: destroy removes the sandbox root", async () => {
    runtime = makeRuntime();
    const local = runtime;
    const root = await local.runPromise(
      Effect.gen(function* () {
        const adapter = yield* VercelSandboxAdapter;
        const context = yield* adapter.provision({
          threadId: "thread-ephemeral",
          plan: planWithPorts([]),
        });
        yield* adapter.destroy(context.instance.id);
        // Destroy is idempotent.
        yield* adapter.destroy(context.instance.id);
        return context.rootPath;
      }),
    );
    expect(existsSync(root)).toBe(false);
  });
});

describe("VercelSandboxClient credential gating", () => {
  it("defaults to the fake when credentials are absent", () => {
    const env: Record<string, string | undefined> = {};
    expect(hasVercelSandboxCredentials(env)).toBe(false);
  });

  it("selects the real path only when every credential is present", () => {
    const env: Record<string, string | undefined> = {};
    for (const key of VERCEL_SANDBOX_CREDENTIAL_ENV) {
      env[key] = "value";
    }
    expect(hasVercelSandboxCredentials(env)).toBe(true);
    // Removing any one credential falls back to the fake.
    env[VERCEL_SANDBOX_CREDENTIAL_ENV[0]] = "";
    expect(hasVercelSandboxCredentials(env)).toBe(false);
  });
});
