import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Engine = "effect-acp" | "official-sdk";

interface BenchmarkAdapter {
  readonly request: (payload: Record<string, unknown>) => Promise<unknown>;
  readonly notify: (payload: Record<string, unknown>) => Promise<void>;
  readonly setPeerDelayMs: (delayMs: number) => void;
  readonly close: () => Promise<void>;
}

interface ScenarioResult {
  readonly name: string;
  readonly operations: number;
  readonly samplesMs: ReadonlyArray<number>;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly operationsPerSecond: number;
  readonly afterRssBytes: number;
  readonly afterHeapUsedBytes: number;
  readonly maxSampleRssBytes: number;
}

interface BenchmarkResult {
  readonly engine: Engine;
  readonly commit: string;
  readonly createdAt: string;
  readonly environment: {
    readonly bun: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly samples: number;
    readonly warmups: number;
    readonly scale: number;
  };
  readonly setupMs: number;
  readonly shutdownMs: number;
  readonly memory: {
    readonly beforeSetupRssBytes: number;
    readonly afterSetupRssBytes: number;
    readonly maxObservedRssBytes: number;
    readonly finalRssBytes: number;
    readonly finalHeapUsedBytes: number;
  };
  readonly scenarios: ReadonlyArray<ScenarioResult>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readArgument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = readArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function percentile(sorted: ReadonlyArray<number>, fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function forceGc(): void {
  if (typeof Bun.gc === "function") Bun.gc(true);
}

function currentCommit(repositoryRoot: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.exitCode === 0 ? decoder.decode(result.stdout).trim() : "unknown";
}

function isRequest(message: unknown): message is { readonly id: string | number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    (typeof message.id === "string" || typeof message.id === "number") &&
    message.id !== ""
  );
}

function makeResponse(message: { readonly id: string | number }): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n`;
}

async function makeOfficialAdapter(): Promise<BenchmarkAdapter> {
  const Acp = await import("@agentclientprotocol/sdk");
  const clientToPeer = new TransformStream<Uint8Array, Uint8Array>();
  const peerToClient = new TransformStream<Uint8Array, Uint8Array>();
  const reader = clientToPeer.readable.getReader();
  const writer = peerToClient.writable.getWriter();
  let stopped = false;
  let peerDelayMs = 0;

  const peer = (async () => {
    let buffered = "";
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          if (peerDelayMs > 0) await sleep(peerDelayMs);
          const message: unknown = JSON.parse(line);
          if (isRequest(message)) await writer.write(encoder.encode(makeResponse(message)));
        }
        newline = buffered.indexOf("\n");
      }
    }
  })().catch((error) => {
    if (!stopped) throw error;
  });

  const connection = Acp.client({ name: "synara-acp-benchmark" }).connect(
    Acp.ndJsonStream(clientToPeer.writable, peerToClient.readable),
  );

  return {
    request: (payload) => connection.agent.request("x/benchmark", payload),
    notify: (payload) => connection.agent.notify("x/benchmark-notification", payload),
    setPeerDelayMs: (delayMs) => {
      peerDelayMs = delayMs;
    },
    close: async () => {
      stopped = true;
      connection.close();
      await reader.cancel().catch(() => undefined);
      await writer.close().catch(() => undefined);
      await peer.catch(() => undefined);
      await connection.closed.catch(() => undefined);
    },
  };
}

async function makeEffectAdapter(effectRoot: string): Promise<BenchmarkAdapter> {
  const serverRoot = path.join(effectRoot, "apps/server");
  const resolveDependency = (specifier: string) =>
    pathToFileURL(Bun.resolveSync(specifier, serverRoot)).href;
  const [Effect, Exit, Queue, Scope, Protocol, Stdio] = await Promise.all([
    import(resolveDependency("effect/Effect")),
    import(resolveDependency("effect/Exit")),
    import(resolveDependency("effect/Queue")),
    import(resolveDependency("effect/Scope")),
    import(pathToFileURL(path.join(effectRoot, "packages/effect-acp/src/protocol.ts")).href),
    import(pathToFileURL(path.join(effectRoot, "packages/effect-acp/src/_internal/stdio.ts")).href),
  ]);
  const scope = await Effect.runPromise(Scope.make());
  const provideScope = (effect: unknown) => Effect.provideService(effect, Scope.Scope, scope);
  const memory = await Effect.runPromise(Stdio.makeInMemoryStdio());
  const protocol = await Effect.runPromise(
    provideScope(
      Protocol.makeAcpPatchedProtocol({
        stdio: memory.stdio,
        serverRequestMethods: new Set(),
      }),
    ),
  );
  let stopped = false;
  let peerDelayMs = 0;
  const peer = (async () => {
    while (!stopped) {
      const chunk = await Effect.runPromise(Queue.take(memory.output));
      for (const rawLine of chunk.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        if (peerDelayMs > 0) await sleep(peerDelayMs);
        const message: unknown = JSON.parse(line);
        if (isRequest(message)) {
          await Effect.runPromise(Queue.offer(memory.input, encoder.encode(makeResponse(message))));
        }
      }
    }
  })().catch((error) => {
    if (!stopped) throw error;
  });

  return {
    request: (payload) => Effect.runPromise(protocol.request("x/benchmark", payload)),
    notify: (payload) => Effect.runPromise(protocol.notify("x/benchmark-notification", payload)),
    setPeerDelayMs: (delayMs) => {
      peerDelayMs = delayMs;
    },
    close: async () => {
      stopped = true;
      await Effect.runPromise(Queue.shutdown(memory.output));
      await Effect.runPromise(Queue.shutdown(memory.input));
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await peer.catch(() => undefined);
    },
  };
}

async function measureScenario(input: {
  readonly name: string;
  readonly operations: number;
  readonly warmups: number;
  readonly samples: number;
  readonly run: () => Promise<void>;
  readonly observeMemory: () => NodeJS.MemoryUsage;
}): Promise<ScenarioResult> {
  for (let index = 0; index < input.warmups; index += 1) await input.run();
  forceGc();
  const samplesMs: number[] = [];
  let maxSampleRssBytes = 0;
  for (let index = 0; index < input.samples; index += 1) {
    const startedAt = performance.now();
    await input.run();
    samplesMs.push(performance.now() - startedAt);
    const memory = input.observeMemory();
    maxSampleRssBytes = Math.max(maxSampleRssBytes, memory.rss);
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const p50Ms = percentile(sorted, 0.5);
  return {
    name: input.name,
    operations: input.operations,
    samplesMs,
    p50Ms,
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    operationsPerSecond: p50Ms === 0 ? 0 : (input.operations * 1_000) / p50Ms,
    afterRssBytes: process.memoryUsage().rss,
    afterHeapUsedBytes: process.memoryUsage().heapUsed,
    maxSampleRssBytes,
  };
}

async function run(): Promise<void> {
  const engine = readArgument("engine") as Engine | undefined;
  if (engine !== "effect-acp" && engine !== "official-sdk") {
    throw new Error("Pass --engine=effect-acp or --engine=official-sdk");
  }
  const samples = readPositiveInteger("samples", 12);
  const warmups = readPositiveInteger("warmups", 4);
  const scale = readPositiveInteger("scale", 1);
  const outputPath = readArgument("output");
  const scenarioFilter = new Set(
    (readArgument("scenarios") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const effectRoot = readArgument("effect-root");
  if (engine === "effect-acp" && !effectRoot) {
    throw new Error("The historical Effect engine requires --effect-root=/path/to/checkout");
  }
  const beforeSetupRssBytes = process.memoryUsage().rss;
  const repositoryRoot =
    engine === "effect-acp" ? (effectRoot as string) : path.resolve(import.meta.dir, "../../..");
  const setupStartedAt = performance.now();
  const adapter =
    engine === "official-sdk"
      ? await makeOfficialAdapter()
      : await makeEffectAdapter(effectRoot as string);
  const setupMs = performance.now() - setupStartedAt;
  forceGc();
  const afterSetupRssBytes = process.memoryUsage().rss;
  let maxObservedRssBytes = afterSetupRssBytes;
  const observeMemory = () => {
    const memory = process.memoryUsage();
    maxObservedRssBytes = Math.max(maxObservedRssBytes, memory.rss);
    return memory;
  };

  const smallPayload = { blob: "x".repeat(256) };
  const largePayload = { blob: "x".repeat(64 * 1_024) };
  const scenarios: ScenarioResult[] = [];
  const sequential = (operations: number, payload: Record<string, unknown>) => async () => {
    for (let index = 0; index < operations; index += 1) {
      await adapter.request({ ...payload, sequence: index });
    }
  };
  const concurrent =
    (operations: number, concurrency: number, payload: Record<string, unknown>) => async () => {
      for (let offset = 0; offset < operations; offset += concurrency) {
        await Promise.all(
          Array.from({ length: Math.min(concurrency, operations - offset) }, (_, index) =>
            adapter.request({ ...payload, sequence: offset + index }),
          ),
        );
      }
    };
  const notifications = (operations: number, payload: Record<string, unknown>) => async () => {
    for (let index = 0; index < operations; index += 1) {
      await adapter.notify({ ...payload, sequence: index });
    }
    await adapter.request({ barrier: true });
  };
  const slowNotifications = (operations: number, payload: Record<string, unknown>) => async () => {
    adapter.setPeerDelayMs(1);
    try {
      await notifications(operations, payload)();
    } finally {
      adapter.setPeerDelayMs(0);
    }
  };
  const definitions = [
    {
      name: "request-sequential-256b",
      operations: 500 * scale,
      run: sequential(500 * scale, smallPayload),
    },
    {
      name: "request-sequential-64k",
      operations: 80 * scale,
      run: sequential(80 * scale, largePayload),
    },
    {
      name: "request-concurrent-32-256b",
      operations: 2_048 * scale,
      run: concurrent(2_048 * scale, 32, smallPayload),
    },
    {
      name: "notification-256b",
      operations: 4_000 * scale,
      run: notifications(4_000 * scale, smallPayload),
    },
    {
      name: "notification-64k",
      operations: 400 * scale,
      run: notifications(400 * scale, largePayload),
    },
    {
      name: "notification-slow-peer-1ms-256b",
      operations: 100 * scale,
      run: slowNotifications(100 * scale, smallPayload),
    },
  ].filter((definition) => scenarioFilter.size === 0 || scenarioFilter.has(definition.name));
  if (definitions.length === 0) throw new Error("--scenarios did not match any benchmark scenario");

  let shutdownMs = 0;
  try {
    for (const definition of definitions) {
      console.error(`${engine}: running ${definition.name}`);
      scenarios.push(
        await measureScenario({
          ...definition,
          warmups,
          samples,
          observeMemory,
        }),
      );
    }
  } finally {
    const shutdownStartedAt = performance.now();
    await adapter.close();
    shutdownMs = performance.now() - shutdownStartedAt;
  }

  forceGc();
  const finalMemory = process.memoryUsage();
  const result: BenchmarkResult = {
    engine,
    commit: currentCommit(repositoryRoot),
    createdAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      samples,
      warmups,
      scale,
    },
    setupMs,
    shutdownMs,
    memory: {
      beforeSetupRssBytes,
      afterSetupRssBytes,
      maxObservedRssBytes,
      finalRssBytes: finalMemory.rss,
      finalHeapUsedBytes: finalMemory.heapUsed,
    },
    scenarios,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await Bun.write(outputPath, serialized);
  else process.stdout.write(serialized);
  console.error(
    `${engine}: ${scenarios.map((scenario) => `${scenario.name}=${scenario.operationsPerSecond.toFixed(0)} ops/s`).join(", ")}`,
  );
}

await run();
process.exit(0);
