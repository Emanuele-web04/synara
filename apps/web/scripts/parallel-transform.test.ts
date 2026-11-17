import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  threadWorkerFactory,
  transformWorkerCount,
  withParallelTransform,
  type TransformWorker,
} from "./parallel-transform";

type Listener = (payload: never) => void;
type Task = { taskId: number; code: string; id: string; moduleType?: string; environment: unknown };

/** A scripted stand-in for a worker thread; replies only when the test says so. */
class FakeWorker implements TransformWorker {
  readonly received: Task[] = [];
  readonly listeners: Record<string, Listener[]> = {};
  unreferenced = false;
  terminated = false;
  postMessage(message: unknown) {
    this.received.push(message as Task);
  }
  on(event: string, listener: Listener) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  ref() {
    this.unreferenced = false;
  }
  async terminate() {
    this.terminated = true;
    return 1;
  }
  unref() {
    this.unreferenced = true;
  }
  emit(event: string, payload: unknown) {
    for (const listener of this.listeners[event] ?? []) listener(payload as never);
  }
  reply(index: number, reply: Record<string, unknown>) {
    this.emit("message", { taskId: this.received[index]!.taskId, ...reply });
  }
}

function fixture(workers = 2) {
  const created: FakeWorker[] = [];
  const reported: unknown[] = [];
  const plugin = withParallelTransform(
    {
      name: "fixture",
      transform: {
        filter: undefined as unknown,
        handler(): unknown {
          throw new Error("The main thread must not compile.");
        },
      },
    },
    {
      workers,
      createWorker: () => {
        const worker = new FakeWorker();
        created.push(worker);
        return worker;
      },
    },
  );
  const context = {
    environment: { name: "client", config: { consumer: "client" } },
    error(failure: unknown): never {
      reported.push(failure);
      throw new Error("reported");
    },
  };
  const handler = plugin.transform.handler as (
    this: typeof context,
    code: string,
    id: string,
    options?: { moduleType?: string },
  ) => Promise<unknown>;
  const transform = (id: string, code = `source of ${id}`) =>
    handler.call(context, code, id, { moduleType: "tsx" });
  return { created, reported, plugin, transform, handler };
}

describe("withParallelTransform", () => {
  it("starts no worker until the first transform", () => {
    expect(fixture().created).toHaveLength(0);
  });

  it("sends each module to a worker with its environment and returns that worker's output", async () => {
    const { created, transform } = fixture();
    const first = transform("/src/a.tsx");
    const second = transform("/src/b.tsx");
    expect(created).toHaveLength(2);
    expect(created.every((worker) => !worker.unreferenced)).toBe(true);
    expect(created[0]!.received[0]).toMatchObject({
      code: "source of /src/a.tsx",
      id: "/src/a.tsx",
      moduleType: "tsx",
      environment: { name: "client", consumer: "client" },
    });
    expect(created[1]!.received[0]).toMatchObject({ id: "/src/b.tsx" });
    created[1]!.reply(0, { kind: "result", value: { code: "B", map: { mappings: "b" } } });
    created[0]!.reply(0, { kind: "result", value: { code: "A", map: null } });
    expect(await first).toEqual({ code: "A", map: null });
    expect(await second).toEqual({ code: "B", map: { mappings: "b" } });
    expect(created.every((worker) => worker.unreferenced)).toBe(true);
  });

  it("queues beyond the pool size and never gives one worker two modules at once", async () => {
    const { created, transform } = fixture(1);
    const results = [transform("/src/a.tsx"), transform("/src/b.tsx"), transform("/src/c.tsx")];
    const worker = created[0]!;
    expect(worker.received.map((task) => task.id)).toEqual(["/src/a.tsx"]);
    worker.reply(0, { kind: "result", value: { code: "A", map: null } });
    expect(worker.received.map((task) => task.id)).toEqual(["/src/a.tsx", "/src/b.tsx"]);
    worker.reply(1, { kind: "result", value: { code: "B", map: null } });
    worker.reply(2, { kind: "result", value: { code: "C", map: null } });
    expect(await Promise.all(results)).toEqual([
      { code: "A", map: null },
      { code: "B", map: null },
      { code: "C", map: null },
    ]);
  });

  it("rejects active and queued transforms and terminates workers when Vite closes", async () => {
    const { created, plugin, transform } = fixture(1);
    const active = expect(transform("/src/a.tsx")).rejects.toThrow("pool closed");
    const queued = expect(transform("/src/b.tsx")).rejects.toThrow("pool closed");
    await plugin.closeBundle();
    await Promise.all([active, queued]);
    expect(created[0]!.terminated).toBe(true);

    await plugin.buildStart();
    const rebuilt = transform("/src/a.tsx");
    expect(created).toHaveLength(2);
    created[1]!.reply(0, { kind: "result", value: { code: "A" } });
    await expect(rebuilt).resolves.toEqual({ code: "A" });
    await plugin.closeBundle();
  });

  it("returns undefined for a module the plugin left unchanged", async () => {
    const { created, transform } = fixture(1);
    const result = transform("/src/plain.ts");
    created[0]!.reply(0, { kind: "result", value: null });
    expect(await result).toBeUndefined();
  });

  it("reports a compile error once through the bundler, without retrying", async () => {
    const { created, reported, transform } = fixture(1);
    const result = transform("/src/broken.tsx");
    created[0]!.reply(0, {
      kind: "transform-error",
      error: { message: "[BabelError] Unexpected token", loc: { line: 3, column: 1 }, pos: 42 },
    });
    await expect(result).rejects.toThrow("reported");
    expect(reported).toEqual([
      { message: "[BabelError] Unexpected token", loc: { line: 3, column: 1 }, pos: 42 },
    ]);
    expect(created[0]!.received).toHaveLength(1);
  });

  it("fails the module when its worker crashes on it", async () => {
    const { created, transform } = fixture(1);
    const result = transform("/src/a.tsx");
    created[0]!.reply(0, { kind: "crash", message: "TypeError: boom" });
    await expect(result).rejects.toThrow("Transform worker crashed on /src/a.tsx: TypeError: boom");
  });

  it.each([
    ["error", new Error("out of memory"), "Transform worker failed"],
    ["exit", 1, "Transform worker exited unexpectedly (code 1)"],
  ])(
    "fails every in-flight, queued and later module after a worker %s",
    async (event, payload, message) => {
      const { created, transform } = fixture(1);
      const inFlight = transform("/src/a.tsx");
      const queued = transform("/src/b.tsx");
      created[0]!.emit(event, payload);
      await expect(inFlight).rejects.toThrow(message);
      await expect(queued).rejects.toThrow(message);
      // No silent fallback to the main thread and no replacement worker.
      await expect(transform("/src/c.tsx")).rejects.toThrow(message);
      expect(created).toHaveLength(1);
      expect(created[0]!.terminated).toBe(true);
    },
  );

  it("fails the pool when a worker answers a module it was not given", async () => {
    const { created, transform } = fixture(1);
    const result = transform("/src/a.tsx");
    created[0]!.emit("message", { taskId: 999, kind: "result", value: { code: "X", map: null } });
    await expect(result).rejects.toThrow("out of turn");
  });

  it("requires a named environment", async () => {
    const { handler } = fixture(1);
    await expect(
      handler.call({ error: () => undefined as never } as never, "code", "/src/a.tsx"),
    ).rejects.toThrow("without a named environment");
  });

  it("keeps the hook object the plugin mutates after config resolution", () => {
    const { plugin } = fixture();
    const hook = plugin.transform;
    plugin.transform.filter = { id: /\.tsx$/ };
    expect(plugin.transform).toBe(hook);
  });

  it("rejects a plugin without an object transform hook and an empty pool", () => {
    const createWorker = () => new FakeWorker();
    expect(() => withParallelTransform({ name: "bare" }, { workers: 1, createWorker })).toThrow(
      "no object transform hook",
    );
    expect(() =>
      withParallelTransform(
        { name: "fixture", transform: { handler() {} } },
        { workers: 0, createWorker },
      ),
    ).toThrow("at least one worker");
  });
});

describe("transformWorkerCount", () => {
  it("leaves one core to the bundler and caps the pool", () => {
    expect(transformWorkerCount({}, 1)).toBe(0);
    expect(transformWorkerCount({}, 4)).toBe(3);
    expect(transformWorkerCount({}, 64)).toBe(8);
  });

  it("honours an explicit override and rejects a malformed one", () => {
    expect(transformWorkerCount({ SYNARA_WEB_TRANSFORM_WORKERS: "0" }, 8)).toBe(0);
    expect(transformWorkerCount({ SYNARA_WEB_TRANSFORM_WORKERS: " 2 " }, 8)).toBe(2);
    for (const value of ["-1", "1.5", "many"])
      expect(() => transformWorkerCount({ SYNARA_WEB_TRANSFORM_WORKERS: value }, 8)).toThrow(
        "Invalid SYNARA_WEB_TRANSFORM_WORKERS",
      );
  });
});

describe("the real transform worker", () => {
  const workerUrl = new URL("./parallel-transform.worker.mjs", import.meta.url);
  const context = {
    environment: { name: "client", config: { consumer: "client" } },
    error(failure: unknown): never {
      throw Object.assign(new Error("reported"), { failure });
    },
  };
  type CompilerHandler = (
    this: typeof context,
    code: string,
    id: string,
    options: { moduleType: string },
  ) => unknown;

  async function compileBothWays(code: string, id: string) {
    const { createReactCompilerPlugin } = await import("./react-compiler-plugin.mjs");
    // Main thread: the unwrapped plugin, driven the way the bundler drives it.
    const direct = (await createReactCompilerPlugin()) as unknown as {
      configResolved: (config: unknown) => void;
      applyToEnvironment: (environment: unknown) => unknown;
      transform: { handler: CompilerHandler };
    };
    direct.configResolved({});
    direct.applyToEnvironment(context.environment);
    const directHandler = direct.transform.handler;
    const expected = await directHandler.call(context, code, id, { moduleType: "tsx" });

    const pooled = withParallelTransform(await createReactCompilerPlugin(), {
      workers: 1,
      createWorker: threadWorkerFactory(workerUrl),
    });
    const pooledHandler = (pooled.transform as { handler: CompilerHandler }).handler;
    try {
      const actual = await pooledHandler.call(context, code, id, { moduleType: "tsx" });
      return { expected, actual };
    } finally {
      await pooled.closeBundle();
    }
  }

  it("compiles a component to exactly what the plugin produces on the main thread", async () => {
    const id = fileURLToPath(new URL("./fixture-component.tsx", import.meta.url));
    const code = [
      'import { useState } from "react";',
      "export function Counter({ step }: { step: number }) {",
      "  const [count, setCount] = useState(0);",
      "  const label = `${count} by ${step}`;",
      "  return <button onClick={() => setCount(count + step)}>{label}</button>;",
      "}",
    ].join("\n");
    const { expected, actual } = await compileBothWays(code, id);
    expect((expected as { code: string }).code).toContain("react/compiler-runtime");
    expect(actual).toEqual(expected);
  }, 60_000);

  it("reports a syntax error through the bundler's error hook", async () => {
    const pooled = withParallelTransform(
      await (await import("./react-compiler-plugin.mjs")).createReactCompilerPlugin(),
      { workers: 1, createWorker: threadWorkerFactory(workerUrl) },
    );
    const handler = (pooled.transform as { handler: CompilerHandler }).handler;
    const id = fileURLToPath(new URL("./fixture-broken.tsx", import.meta.url));
    try {
      await expect(
        handler.call(context, "export function Use() { return <div>; }", id, { moduleType: "tsx" }),
      ).rejects.toMatchObject({
        message: "reported",
        failure: { message: expect.stringContaining("[BabelError]") },
      });
    } finally {
      await pooled.closeBundle();
    }
  }, 60_000);
});
