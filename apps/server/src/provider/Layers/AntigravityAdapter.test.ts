import type { ChildProcess, SpawnOptions } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import type { WindowsSafeProcessInput } from "@synara/shared/windowsProcess";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config";
import { AntigravityAdapter, type AntigravityAdapterShape } from "../Services/AntigravityAdapter";
import {
  ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES,
  type AntigravityAdapterLiveOptions,
  type AntigravityProcessDependencies,
  type AntigravityTurnProcessResult,
  buildAntigravityHookConfig,
  antigravityPromptCommandLineIssue,
  hookScriptSource,
  makeAntigravityAdapterLive,
  makeAntigravityRuntimeEventBase,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  readCompleteAntigravityLines,
  resolveAntigravityCliModelLabel,
  runAntigravityHelperProcess,
  startAntigravityTurnProcess,
} from "./AntigravityAdapter";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (cause?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
}

type FakeChild = {
  readonly child: ChildProcess;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly emitError: (cause: Error) => void;
  readonly emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function makeFakeChild(pid = 42_000): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, {
    pid,
    stdin: null,
    stdout,
    stderr,
    stdio: [null, stdout, stderr],
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  const child = emitter as unknown as ChildProcess;
  return {
    child,
    stdout,
    stderr,
    emitError: (cause) => child.emit("error", cause),
    emitClose: (code, signal = null) => {
      Object.assign(emitter, { exitCode: code, signalCode: signal });
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    },
  };
}

function fakeProcessDependencies(
  fake: FakeChild,
  overrides: Partial<AntigravityProcessDependencies> = {},
): AntigravityProcessDependencies {
  return {
    prepareProcess: (command, args) => ({ command, args: [...args], shell: false }),
    spawnProcess: (_command: string, _args: ReadonlyArray<string>, _options: SpawnOptions) =>
      fake.child,
    teardownProcessTree: async () => undefined,
    ...overrides,
  };
}

async function runWithAdapter<T>(
  options: AntigravityAdapterLiveOptions,
  use: (adapter: AntigravityAdapterShape) => Promise<T>,
): Promise<T> {
  const layer = makeAntigravityAdapterLive(options).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "synara-antigravity-adapter-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* AntigravityAdapter;
        return yield* Effect.promise(() => use(adapter));
      }).pipe(Effect.provide(layer)),
    ),
  );
}

async function startFakeAdapterTurn(input: {
  readonly fake: FakeChild;
  readonly teardownProcessTree: NonNullable<AntigravityProcessDependencies["teardownProcessTree"]>;
  readonly beforeTurnFinalization?: AntigravityAdapterLiveOptions["beforeTurnFinalization"];
  readonly use: (adapter: AntigravityAdapterShape, threadId: ThreadId) => Promise<void>;
}): Promise<void> {
  const threadId = ThreadId.makeUnsafe(`antigravity-test-${crypto.randomUUID()}`);
  await runWithAdapter(
    {
      ...fakeProcessDependencies(input.fake, {
        teardownProcessTree: input.teardownProcessTree,
      }),
      installCapturePlugin: async () => undefined,
      ...(input.beforeTurnFinalization
        ? { beforeTurnFinalization: input.beforeTurnFinalization }
        : {}),
      pollIntervalMs: 5,
    },
    async (adapter) => {
      await Effect.runPromise(
        adapter.startSession({
          provider: "antigravity",
          threadId,
          runtimeMode: "full-access",
          providerOptions: { antigravity: { binaryPath: "fake-antigravity" } },
        }),
      );
      await Effect.runPromise(adapter.sendTurn({ threadId, input: "test prompt" }));
      await input.use(adapter, threadId);
    },
  );
}

describe("Antigravity CLI model translation", () => {
  it("collapses CLI model/effort labels into base models with effort ladders", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
`),
    ).toEqual([
      {
        slug: "Gemini 3.5 Flash",
        name: "Gemini 3.5 Flash",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "Gemini 3.1 Pro",
        name: "Gemini 3.1 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 4.6",
        name: "Claude Sonnet 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "Claude Opus 4.6",
        name: "Claude Opus 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "GPT-OSS 120B",
        name: "GPT-OSS 120B",
        supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("rebuilds the exact CLI model label only at dispatch", () => {
    expect(parseAntigravityCliModelLabel("Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash")).toBe("Gemini 3.5 Flash (Medium)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash", { reasoningEffort: "high" })).toBe(
      "Gemini 3.5 Flash (High)",
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash (Low)")).toBe(
      "Gemini 3.5 Flash (Low)",
    );
  });

  it("accepts bullet-prefixed model output", () => {
    expect(parseAntigravityCliModelLabel("* Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("• Claude Sonnet 4.6 (Thinking)")).toEqual({
      model: "Claude Sonnet 4.6",
      effort: "thinking",
    });
  });

  it("discovers future CLI models without requiring a static catalog update", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 4 Pro (Low)
Gemini 4 Pro (Ultra)
Claude Sonnet 5 (Thinking)
`),
    ).toEqual([
      {
        slug: "Gemini 4 Pro",
        name: "Gemini 4 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "ultra", label: "Ultra" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 5",
        name: "Claude Sonnet 5",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  it("dispatches a discovered model with its discovered default effort", () => {
    expect(resolveAntigravityCliModelLabel("Gemini 4 Pro", undefined, "low")).toBe(
      "Gemini 4 Pro (Low)",
    );
  });
});

describe("Antigravity CLI integration helpers", () => {
  it("propagates the owning lifecycle generation into runtime events", () => {
    expect(
      makeAntigravityRuntimeEventBase({
        threadId: "thread-antigravity-lifecycle" as never,
        lifecycleGeneration: "generation-1",
        eventId: "event-1" as never,
        createdAt: "2026-07-17T00:00:00.000Z",
      }),
    ).toMatchObject({
      provider: "antigravity",
      threadId: "thread-antigravity-lifecycle",
      lifecycleGeneration: "generation-1",
      eventId: "event-1",
      createdAt: "2026-07-17T00:00:00.000Z",
    });
  });

  it("keeps the globally installed hook neutral outside Synara sessions", async () => {
    const result = await runAntigravityHelperProcess(
      process.execPath,
      ["-e", hookScriptSource(), "pre-tool"],
      { timeoutMs: 1_000 },
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  });

  it("guards Windows command-line limits before spawning the CLI", () => {
    expect(antigravityPromptCommandLineIssue("x".repeat(24_000), "win32")).toBeNull();
    expect(antigravityPromptCommandLineIssue("x".repeat(24_001), "win32")).toContain(
      "limited to 24,000 characters",
    );
    expect(antigravityPromptCommandLineIssue("x".repeat(120_000), "darwin")).toBeNull();
  });

  it("marks every generated hook as a command hook", () => {
    expect(buildAntigravityHookConfig((event) => `capture ${event}`)).toEqual({
      "synara-capture": {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "capture pre-tool" }],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "capture post-tool" }],
          },
        ],
        PreInvocation: [{ type: "command", command: "capture pre-invocation" }],
        PostInvocation: [{ type: "command", command: "capture post-invocation" }],
        Stop: [{ type: "command", command: "capture stop" }],
      },
    });
  });

  it("advances file offsets only past complete JSONL records", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-test-"));
    const file = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(file, '{"first":true}\n{"second"');
      const first = await readCompleteAntigravityLines(file, 0);
      expect(first).toEqual({ lines: ['{"first":true}'], nextOffset: 15 });

      await fs.appendFile(file, ":true}\n");
      const second = await readCompleteAntigravityLines(file, first.nextOffset);
      expect(second).toEqual({ lines: ['{"second":true}'], nextOffset: 31 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates helper processes that exceed their timeout", async () => {
    await expect(
      runAntigravityHelperProcess(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Antigravity helper timed out after 50ms");
  });
});

describe("Antigravity process spawning and output ownership", () => {
  it.runIf(process.platform === "win32")(
    "preserves native Windows helper and turn arguments plus under-cap stdout/stderr",
    async () => {
      const values = ["plain", "value with spaces", 'quote " inside', "café-東京"];
      const stderr = 'native stderr "exact" café-東京';
      const script =
        `process.stdout.write(JSON.stringify(process.argv.slice(1)));` +
        `process.stderr.write(${JSON.stringify(stderr)});`;
      const args = ["-e", script, ...values];

      const helper = await runAntigravityHelperProcess(process.execPath, args, {
        timeoutMs: 2_000,
      });
      expect(helper).toMatchObject({
        code: 0,
        stdout: JSON.stringify(values),
        stderr,
        outputTruncated: false,
      });
      expect(helper.retainedOutputBytes).toBe(
        Buffer.byteLength(helper.stdout) + Buffer.byteLength(helper.stderr),
      );

      let finalized: AntigravityTurnProcessResult | undefined;
      const lifecycle = startAntigravityTurnProcess({
        command: process.execPath,
        args,
        cwd: process.cwd(),
        env: process.env,
        onFinalize: async (result) => {
          finalized = result;
        },
      });
      const turn = await lifecycle.finalization;
      expect(turn).toMatchObject({
        code: 0,
        signal: null,
        stdout: JSON.stringify(values),
        stderr,
        outputTruncated: false,
        teardownRequested: false,
      });
      expect(finalized).toEqual(turn);
    },
  );

  it.runIf(process.platform === "win32")(
    "runs a real .cmd helper and turn from a path with spaces and non-ASCII",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara agy café 東京 "));
      const scriptPath = path.join(directory, "echo args.cjs");
      const commandPath = path.join(directory, "echo args.cmd");
      const values = ["ordinary", "space value", 'quoted " value', "naïve-東京"];
      const stderr = "cmd stderr café-東京";
      try {
        await fs.writeFile(
          scriptPath,
          `process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write(${JSON.stringify(stderr)});`,
        );
        await fs.writeFile(
          commandPath,
          `@echo off\r\n"${process.execPath}" "%~dp0echo args.cjs" %*\r\n`,
        );

        const helper = await runAntigravityHelperProcess(commandPath, values, {
          cwd: directory,
          timeoutMs: 2_000,
        });
        expect(helper).toMatchObject({
          code: 0,
          stdout: JSON.stringify(values),
          stderr,
          outputTruncated: false,
        });

        let finalized: AntigravityTurnProcessResult | undefined;
        const lifecycle = startAntigravityTurnProcess({
          command: commandPath,
          args: values,
          cwd: directory,
          env: process.env,
          onFinalize: async (result) => {
            finalized = result;
          },
        });
        const turn = await lifecycle.finalization;
        expect(turn).toMatchObject({
          code: 0,
          signal: null,
          stdout: JSON.stringify(values),
          stderr,
          outputTruncated: false,
        });
        expect(finalized).toEqual(turn);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects .cmd command and argument metacharacters before spawn without executing a sentinel",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-agy-sentinel-"));
      const sentinel = path.join(directory, "executed.txt");
      const commandPath = path.join(directory, "sentinel.cmd");
      const fake = makeFakeChild();
      const spawnProcess = vi.fn(
        (_command: string, _args: ReadonlyArray<string>, _options: SpawnOptions) => fake.child,
      );
      const dependencies: AntigravityProcessDependencies = { spawnProcess };
      const onFinalize = async () => undefined;
      try {
        await fs.writeFile(commandPath, `@echo executed>"${sentinel}"\r\n`);

        await expect(
          runAntigravityHelperProcess(commandPath, ["safe & unsafe"], {
            cwd: directory,
            dependencies,
          }),
        ).rejects.toThrow("cmd.exe control characters");
        await expect(
          runAntigravityHelperProcess(`${commandPath}&unsafe.cmd`, ["safe"], {
            cwd: directory,
            dependencies,
          }),
        ).rejects.toThrow("cmd.exe control characters");
        expect(() =>
          startAntigravityTurnProcess({
            command: commandPath,
            args: ["safe | unsafe"],
            cwd: directory,
            env: process.env,
            dependencies,
            onFinalize,
          }),
        ).toThrow("cmd.exe control characters");
        expect(() =>
          startAntigravityTurnProcess({
            command: `${commandPath}^unsafe.cmd`,
            args: ["safe"],
            cwd: directory,
            env: process.env,
            dependencies,
            onFinalize,
          }),
        ).toThrow("cmd.exe control characters");

        expect(spawnProcess).not.toHaveBeenCalled();
        await expect(fs.access(sentinel)).rejects.toThrow();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("propagates prepared shell options for helper and turn launches", async () => {
    const helperFake = makeFakeChild(42_001);
    let helperPreparedInput: WindowsSafeProcessInput | undefined;
    const helperPrepare = vi.fn(
      (command: string, args: ReadonlyArray<string>, input: WindowsSafeProcessInput = {}) => {
        helperPreparedInput = input;
        return {
          command: `prepared-${command}`,
          args: [...args, "prepared"],
          shell: false as const,
          windowsHide: true as const,
          windowsVerbatimArguments: true as const,
          input,
        };
      },
    );
    let helperSpawnOptions: SpawnOptions | undefined;
    const helperPromise = runAntigravityHelperProcess("helper.exe", ["one"], {
      cwd: "C:\\helper cwd",
      dependencies: {
        prepareProcess: helperPrepare,
        spawnProcess: (_command, _args, options) => {
          helperSpawnOptions = options;
          return helperFake.child;
        },
      },
    });
    helperFake.emitClose(0);
    await helperPromise;
    expect(helperPrepare).toHaveBeenCalledOnce();
    expect(helperSpawnOptions).toMatchObject({
      cwd: "C:\\helper cwd",
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(helperSpawnOptions?.env).toBe(helperPreparedInput?.env);

    const turnFake = makeFakeChild(42_002);
    const turnEnv = { TEST_ENV: "turn" };
    let turnSpawnOptions: SpawnOptions | undefined;
    const lifecycle = startAntigravityTurnProcess({
      command: "turn.exe",
      args: ["two"],
      cwd: "C:\\turn cwd",
      env: turnEnv,
      dependencies: {
        prepareProcess: (command, args, input) => {
          expect(input).toEqual({ cwd: "C:\\turn cwd", env: turnEnv });
          return {
            command: `prepared-${command}`,
            args: [...args],
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true,
          };
        },
        spawnProcess: (_command, _args, options) => {
          turnSpawnOptions = options;
          return turnFake.child;
        },
      },
      onFinalize: async () => undefined,
    });
    turnFake.emitClose(0);
    await lifecycle.finalization;
    expect(turnSpawnOptions).toMatchObject({
      cwd: "C:\\turn cwd",
      env: turnEnv,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it.each([
    {
      name: "stdout-only",
      write: (fake: FakeChild) =>
        fake.stdout.write("a".repeat(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES + 9)),
      stdout: "a".repeat(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES),
      stderr: "",
      bytes: ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES,
    },
    {
      name: "stderr-only",
      write: (fake: FakeChild) =>
        fake.stderr.write("b".repeat(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES + 9)),
      stdout: "",
      stderr: "b".repeat(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES),
      bytes: ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES,
    },
    {
      name: "combined with a split multibyte boundary",
      write: (fake: FakeChild) => {
        fake.stdout.write("c".repeat(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES - 5));
        fake.stderr.write("ééé-tail");
        fake.stdout.write("ignored-after-overflow");
      },
      stdout: "c".repeat(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES - 5),
      stderr: "éé",
      bytes: ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES - 1,
    },
  ])("bounds $name helper output at ingestion", async ({ write, stdout, stderr, bytes }) => {
    const fake = makeFakeChild();
    const promise = runAntigravityHelperProcess("fake-helper", [], {
      dependencies: fakeProcessDependencies(fake),
    });
    write(fake);
    fake.emitClose(0);
    const result = await promise;
    expect(result).toEqual({
      code: 0,
      stdout,
      stderr,
      outputTruncated: true,
      retainedOutputBytes: bytes,
    });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES,
    );
  });

  it("applies the same combined byte cap to turn output", async () => {
    const fake = makeFakeChild();
    let finalized: AntigravityTurnProcessResult | undefined;
    const lifecycle = startAntigravityTurnProcess({
      command: "fake-turn",
      args: [],
      env: process.env,
      dependencies: fakeProcessDependencies(fake),
      onFinalize: async (result) => {
        finalized = result;
      },
    });
    fake.stderr.write("d".repeat(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES - 2));
    fake.stdout.write("é-more");
    fake.stderr.write("ignored");
    fake.emitClose(0);

    const result = await lifecycle.finalization;
    expect(result.stderr).toBe("d".repeat(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES - 2));
    expect(result.stdout).toBe("é");
    expect(result.outputTruncated).toBe(true);
    expect(result.retainedOutputBytes).toBe(ANTIGRAVITY_PROCESS_OUTPUT_MAX_BYTES);
    expect(finalized).toEqual(result);
  });

  it("keeps helper timeout pending until supervised teardown completes", async () => {
    const fake = makeFakeChild();
    const teardown = deferred<void>();
    const teardownProcessTree = vi.fn(() => teardown.promise);
    const helper = runAntigravityHelperProcess("fake-helper", [], {
      timeoutMs: 10,
      dependencies: fakeProcessDependencies(fake, { teardownProcessTree }),
    });

    await waitFor(() => teardownProcessTree.mock.calls.length === 1);
    await expectPending(helper);
    fake.emitClose(null, "SIGKILL");
    await expectPending(helper);
    teardown.resolve(undefined);
    await expect(helper).rejects.toThrow("Antigravity helper timed out after 10ms");
    expect(teardownProcessTree).toHaveBeenCalledOnce();
    expect(fake.child.listenerCount("error")).toBe(0);
    expect(fake.child.listenerCount("close")).toBe(0);
    expect(fake.stdout.listenerCount("data")).toBe(0);
    expect(fake.stderr.listenerCount("data")).toBe(0);
  });

  it("settles helper spawn error and early close once without timers or listeners leaking", async () => {
    const spawnErrorFake = makeFakeChild(42_003);
    const spawnErrorTeardown = vi.fn(async () => undefined);
    const spawnFailure = new Error("simulated spawn failure");
    const spawnErrorResult = runAntigravityHelperProcess("fake-helper", [], {
      timeoutMs: 20,
      dependencies: fakeProcessDependencies(spawnErrorFake, {
        teardownProcessTree: spawnErrorTeardown,
      }),
    });
    spawnErrorFake.emitError(spawnFailure);
    spawnErrorFake.emitClose(1);
    await expect(spawnErrorResult).rejects.toBe(spawnFailure);

    const closeFake = makeFakeChild(42_004);
    const closeTeardown = vi.fn(async () => undefined);
    const closeResult = runAntigravityHelperProcess("fake-helper", [], {
      timeoutMs: 20,
      dependencies: fakeProcessDependencies(closeFake, { teardownProcessTree: closeTeardown }),
    });
    closeFake.emitClose(0);
    await expect(closeResult).resolves.toMatchObject({ code: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(spawnErrorTeardown).not.toHaveBeenCalled();
    expect(closeTeardown).not.toHaveBeenCalled();
    for (const fake of [spawnErrorFake, closeFake]) {
      expect(fake.child.listenerCount("error")).toBe(0);
      expect(fake.child.listenerCount("close")).toBe(0);
      expect(fake.stdout.listenerCount("data")).toBe(0);
      expect(fake.stderr.listenerCount("data")).toBe(0);
    }
  });

  it("finalizes a turn spawn error once when close races behind it", async () => {
    const fake = makeFakeChild(42_005);
    const failure = new Error("turn spawn failed");
    const teardownProcessTree = vi.fn(async () => undefined);
    const onFinalize = vi.fn(async () => undefined);
    const lifecycle = startAntigravityTurnProcess({
      command: "fake-turn",
      args: [],
      env: process.env,
      dependencies: fakeProcessDependencies(fake, { teardownProcessTree }),
      onFinalize,
    });

    fake.emitError(failure);
    fake.emitClose(1);
    await expect(lifecycle.finalization).rejects.toBe(failure);
    expect(onFinalize).toHaveBeenCalledOnce();
    expect(teardownProcessTree).not.toHaveBeenCalled();
    expect(fake.child.listenerCount("error")).toBe(0);
    expect(fake.child.listenerCount("close")).toBe(0);
    expect(fake.stdout.listenerCount("data")).toBe(0);
    expect(fake.stderr.listenerCount("data")).toBe(0);
  });

  it("awaits requested teardown when spawn error and close race behind it", async () => {
    const fake = makeFakeChild(42_006);
    const teardown = deferred<void>();
    const spawnFailure = new Error("turn spawn failed during teardown");
    const teardownFailure = new Error("process-tree exit could not be proven");
    let finalized: AntigravityTurnProcessResult | undefined;
    const teardownProcessTree = vi.fn(() => teardown.promise);
    const onFinalize = vi.fn(async (result: AntigravityTurnProcessResult) => {
      finalized = result;
    });
    const lifecycle = startAntigravityTurnProcess({
      command: "fake-turn",
      args: [],
      env: process.env,
      dependencies: fakeProcessDependencies(fake, { teardownProcessTree }),
      onFinalize,
    });

    const teardownAndFinalize = lifecycle.teardownAndFinalize();
    await waitFor(() => teardownProcessTree.mock.calls.length === 1);
    fake.emitError(spawnFailure);
    fake.emitClose(1);

    await expectPending(lifecycle.finalization);
    await expectPending(teardownAndFinalize);
    expect(onFinalize).not.toHaveBeenCalled();

    const finalizationAssertion = expect(lifecycle.finalization).rejects.toBe(teardownFailure);
    const teardownAssertion = expect(teardownAndFinalize).rejects.toBe(teardownFailure);
    teardown.reject(teardownFailure);
    await Promise.all([finalizationAssertion, teardownAssertion]);

    expect(onFinalize).toHaveBeenCalledOnce();
    expect(finalized).toMatchObject({
      spawnError: spawnFailure,
      teardownError: teardownFailure,
      teardownRequested: true,
    });
    expect(teardownProcessTree).toHaveBeenCalledOnce();
    expect(fake.child.listenerCount("error")).toBe(0);
    expect(fake.child.listenerCount("close")).toBe(0);
    expect(fake.stdout.listenerCount("data")).toBe(0);
    expect(fake.stderr.listenerCount("data")).toBe(0);
  });

  it("makes late lifecycle callers await an already observed normal close", async () => {
    const fake = makeFakeChild(42_007);
    const finalizationGate = deferred<void>();
    const teardownProcessTree = vi.fn(async () => undefined);
    const onFinalize = vi.fn(() => finalizationGate.promise);
    const lifecycle = startAntigravityTurnProcess({
      command: "fake-turn",
      args: [],
      env: process.env,
      dependencies: fakeProcessDependencies(fake, { teardownProcessTree }),
      onFinalize,
    });

    fake.emitClose(0);
    await waitFor(() => onFinalize.mock.calls.length === 1);
    const lateLifecycleCall = lifecycle.teardownAndFinalize();
    await expectPending(lateLifecycleCall);
    expect(teardownProcessTree).not.toHaveBeenCalled();

    finalizationGate.resolve(undefined);
    const [terminalResult, lateResult] = await Promise.all([
      lifecycle.finalization,
      lateLifecycleCall,
    ]);
    expect(lateResult).toEqual(terminalResult);
    expect(onFinalize).toHaveBeenCalledOnce();
  });

  it("rejects abnormal turn exit when descendant survival cannot be disproven", async () => {
    const fake = makeFakeChild();
    const failure = new Error("descendants still running after supervised teardown");
    const teardown = deferred<void>();
    let finalized: AntigravityTurnProcessResult | undefined;
    const onFinalize = vi.fn(async (result: AntigravityTurnProcessResult) => {
      finalized = result;
    });
    const teardownProcessTree = vi.fn(() => teardown.promise);
    const lifecycle = startAntigravityTurnProcess({
      command: "fake-turn",
      args: [],
      env: process.env,
      dependencies: fakeProcessDependencies(fake, { teardownProcessTree }),
      onFinalize,
    });

    fake.emitClose(17);
    await waitFor(() => teardownProcessTree.mock.calls.length === 1);
    await expectPending(lifecycle.finalization);
    expect(onFinalize).not.toHaveBeenCalled();
    teardown.reject(failure);
    await expect(lifecycle.finalization).rejects.toBe(failure);
    expect(teardownProcessTree).toHaveBeenCalledOnce();
    expect(onFinalize).toHaveBeenCalledOnce();
    expect(finalized).toMatchObject({
      code: 17,
      teardownError: failure,
      teardownRequested: true,
    });
  });
});

describe("Antigravity active turn lifecycle", () => {
  it("keeps interrupt pending through shared teardown and full finalization", async () => {
    const fake = makeFakeChild();
    const teardown = deferred<void>();
    const finalization = deferred<void>();
    const teardownProcessTree = vi.fn(() => teardown.promise);
    const beforeTurnFinalization = vi.fn(() => finalization.promise);

    await startFakeAdapterTurn({
      fake,
      teardownProcessTree,
      beforeTurnFinalization,
      use: async (adapter, threadId) => {
        const interrupt = Effect.runPromise(adapter.interruptTurn(threadId));
        await waitFor(() => teardownProcessTree.mock.calls.length === 1);
        await expectPending(interrupt);

        teardown.resolve(undefined);
        await expectPending(interrupt);
        fake.emitClose(null, "SIGTERM");
        await waitFor(() => beforeTurnFinalization.mock.calls.length === 1);
        await expectPending(interrupt);

        finalization.resolve(undefined);
        await interrupt;
        const sessions = await Effect.runPromise(adapter.listSessions());
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ status: "ready" });
        expect(sessions[0]).not.toHaveProperty("activeTurnId");
        expect(teardownProcessTree).toHaveBeenCalledOnce();
      },
    });
  });

  it("keeps stop pending through shared teardown and full finalization", async () => {
    const fake = makeFakeChild();
    const teardown = deferred<void>();
    const finalization = deferred<void>();
    const teardownProcessTree = vi.fn(() => teardown.promise);
    const beforeTurnFinalization = vi.fn(() => finalization.promise);

    await startFakeAdapterTurn({
      fake,
      teardownProcessTree,
      beforeTurnFinalization,
      use: async (adapter, threadId) => {
        const stop = Effect.runPromise(adapter.stopSession(threadId));
        await waitFor(() => teardownProcessTree.mock.calls.length === 1);
        await expectPending(stop);

        teardown.resolve(undefined);
        fake.emitClose(null, "SIGTERM");
        await waitFor(() => beforeTurnFinalization.mock.calls.length === 1);
        await expectPending(stop);
        expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(true);

        finalization.resolve(undefined);
        await stop;
        expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
        expect(teardownProcessTree).toHaveBeenCalledOnce();
      },
    });
  });

  it("keeps restart pending through the active turn's teardown and finalization", async () => {
    const fake = makeFakeChild();
    const teardown = deferred<void>();
    const finalization = deferred<void>();
    const teardownProcessTree = vi.fn(() => teardown.promise);
    const beforeTurnFinalization = vi.fn(() => finalization.promise);

    await startFakeAdapterTurn({
      fake,
      teardownProcessTree,
      beforeTurnFinalization,
      use: async (adapter, threadId) => {
        const restart = Effect.runPromise(
          adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            providerOptions: { antigravity: { binaryPath: "fake-antigravity" } },
          }),
        );
        await waitFor(() => teardownProcessTree.mock.calls.length === 1);
        await expectPending(restart);

        teardown.resolve(undefined);
        fake.emitClose(null, "SIGTERM");
        await waitFor(() => beforeTurnFinalization.mock.calls.length === 1);
        await expectPending(restart);

        finalization.resolve(undefined);
        await expect(restart).resolves.toMatchObject({ status: "ready", threadId });
        const sessions = await Effect.runPromise(adapter.listSessions());
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).not.toHaveProperty("activeTurnId");
        expect(teardownProcessTree).toHaveBeenCalledOnce();
      },
    });
  });

  it("lets teardown failure win over interrupted status and releases turn ownership", async () => {
    const fake = makeFakeChild();
    const failure = new Error("descendant survival could not be disproven");
    const teardownProcessTree = vi.fn(async () => {
      throw failure;
    });

    await startFakeAdapterTurn({
      fake,
      teardownProcessTree,
      use: async (adapter, threadId) => {
        await expect(Effect.runPromise(adapter.interruptTurn(threadId))).rejects.toThrow(
          "descendant survival could not be disproven",
        );
        const sessions = await Effect.runPromise(adapter.listSessions());
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          status: "error",
          lastError: "descendant survival could not be disproven",
        });
        expect(sessions[0]).not.toHaveProperty("activeTurnId");
        expect(fake.child.listenerCount("close")).toBe(0);
        expect(teardownProcessTree).toHaveBeenCalledOnce();
      },
    });
  });
});
