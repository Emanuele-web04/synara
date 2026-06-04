/**
 * Daytona adapter unit tests (fake-client backed).
 *
 * Covers the Daytona-specific lifecycle the shared contract harness does not:
 * snapshot, port exposure, stop, the activity-lease keepalive (`refreshActivity`),
 * and destroy idempotency. Runs against the fake sandbox client so it needs no
 * provider access.
 *
 * @module daytona/DaytonaRuntimeAdapter.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DaytonaRuntimeAdapter } from "./DaytonaRuntimeAdapter.ts";
import { FakeDaytonaSandboxClientLive } from "./FakeDaytonaSandboxClient.ts";
import { DaytonaRuntimeAdapterLive } from "./DaytonaRuntimeAdapter.ts";

const makeRuntime = () =>
  ManagedRuntime.make(
    DaytonaRuntimeAdapterLive.pipe(
      Layer.provide(FakeDaytonaSandboxClientLive),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

type AdapterRuntime = ReturnType<typeof makeRuntime>;

describe("DaytonaRuntimeAdapter (fake client)", () => {
  let runtime: AdapterRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("provisions a daytona-provider instance and reports it alive", async () => {
    runtime = makeRuntime();
    const localRuntime = runtime;
    const context = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DaytonaRuntimeAdapter;
        return yield* adapter.provision({ threadId: "t-1", ports: [], snapshotId: null });
      }),
    );
    expect(context.instance.provider).toBe("daytona");
    expect(context.instance.status).toBe("running");
    expect(context.rootPath.length).toBeGreaterThan(0);

    const alive = await localRuntime.runPromise(
      Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
        adapter.isAlive(context.instance.id),
      ),
    );
    expect(alive).toBe(true);
  });

  it("exposes a port, snapshots, refreshes activity, and stops without destroying", async () => {
    runtime = makeRuntime();
    const localRuntime = runtime;
    const result = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DaytonaRuntimeAdapter;
        const context = yield* adapter.provision({
          threadId: "t-2",
          ports: [3000],
          snapshotId: null,
        });
        const route = yield* adapter.exposePort(context.instance.id, 3000);
        const snapshot = yield* adapter.snapshot(context.instance.id, "checkpoint");
        // The keepalive must not throw while a turn holds the lease.
        yield* adapter.refreshActivity(context.instance.id);
        yield* adapter.stop(context.instance.id);
        // A stopped sandbox is not "running" but the provider still knows it (FS
        // persists), so it is not yet a lost instance.
        const aliveAfterStop = yield* adapter.isAlive(context.instance.id);
        return { route, snapshot, aliveAfterStop };
      }),
    );
    expect(result.route.url).toContain("3000");
    expect(result.snapshot.snapshotId.length).toBeGreaterThan(0);
    expect(result.aliveAfterStop).toBe(false);
  });

  it("destroys idempotently and stops recognizing the instance", async () => {
    runtime = makeRuntime();
    const localRuntime = runtime;
    const outcome = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* DaytonaRuntimeAdapter;
        const context = yield* adapter.provision({ threadId: "t-3", ports: [], snapshotId: null });
        yield* adapter.destroy(context.instance.id);
        const aliveAfterDestroy = yield* adapter.isAlive(context.instance.id);
        // Destroying again is a no-op, not an error.
        yield* adapter.destroy(context.instance.id);
        return aliveAfterDestroy;
      }),
    );
    expect(outcome).toBe(false);
  });

  it("resumes from a snapshot id at provision", async () => {
    runtime = makeRuntime();
    const localRuntime = runtime;
    const context = await localRuntime.runPromise(
      Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
        adapter.provision({ threadId: "t-4", ports: [], snapshotId: "snap-prior" }),
      ),
    );
    expect(context.instance.provider).toBe("daytona");
    expect(context.instance.status).toBe("running");
  });
});
