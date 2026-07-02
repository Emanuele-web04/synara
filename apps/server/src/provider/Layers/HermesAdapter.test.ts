import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import { ThreadId } from "@t3tools/contracts";
import { HermesAdapter } from "../Services/HermesAdapter.ts";
import { makeHermesAdapterLive, type HermesAdapterLiveOptions } from "./HermesAdapter.ts";

type HermesExecFile = NonNullable<HermesAdapterLiveOptions["execFile"]>;
type HermesExecResult = Awaited<ReturnType<HermesExecFile>>;

function makePendingHermesExecFile() {
  let resolveExec: ((value: HermesExecResult) => void) | undefined;
  let rejectExec: ((reason: Error) => void) | undefined;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const promise = new Promise<HermesExecResult>((resolve, reject) => {
    resolveExec = resolve;
    rejectExec = reject;
  });
  const execFile = vi.fn<HermesExecFile>((_binary, _args, options) => {
    resolveStarted?.();
    options?.signal?.addEventListener("abort", () => {
      rejectExec?.(new Error("Hermes process aborted"));
    });
    return promise;
  });

  return {
    execFile,
    started,
    resolve: (value: HermesExecResult) => {
      resolveExec?.(value);
    },
    reject: (reason: Error) => {
      rejectExec?.(reason);
    },
  } as const;
}

describe("HermesAdapterLive", () => {
  it("runs hermes chat in quiet one-shot mode and stores assistant output", async () => {
    const execFile = vi.fn<HermesExecFile>(async () => ({
      stdout: "Synara Hermes smoke OK.\n",
      stderr: "",
    }));
    const threadId = ThreadId.makeUnsafe("thread-hermes-test");

    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "hermes",
          cwd: "/tmp/synara-hermes",
          runtimeMode: "full-access",
          modelSelection: { provider: "hermes", model: "coder3" },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Say exactly: Synara Hermes smoke OK.",
          modelSelection: { provider: "hermes", model: "coder3" },
        });
        yield* Effect.sleep("20 millis");
        return yield* adapter.readThread(threadId);
      }).pipe(
        Effect.provide(
          makeHermesAdapterLive({
            binaryPath: "/usr/local/bin/hermes-test",
            execFile,
          }),
        ),
      ),
    );

    expect(execFile).toHaveBeenCalledWith(
      "/usr/local/bin/hermes-test",
      ["chat", "--quiet", "--query", "Say exactly: Synara Hermes smoke OK.", "--profile", "coder3"],
      expect.objectContaining({ cwd: "/tmp/synara-hermes" }),
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemType: "assistant_message", text: "Synara Hermes smoke OK." }),
      ]),
    );
  });

  it("uses the configured Hermes binary path from provider start options", async () => {
    const execFile = vi.fn<HermesExecFile>(async () => ({
      stdout: "configured binary OK.\n",
      stderr: "",
    }));
    const threadId = ThreadId.makeUnsafe("thread-hermes-binary-path-test");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "hermes",
          runtimeMode: "full-access",
          providerOptions: { hermes: { binaryPath: "/opt/bin/hermes-custom" } },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Say exactly: configured binary OK.",
        });
        yield* Effect.sleep("20 millis");
      }).pipe(
        Effect.provide(
          makeHermesAdapterLive({
            binaryPath: "/usr/local/bin/hermes-fallback",
            execFile,
          }),
        ),
      ),
    );

    expect(execFile).toHaveBeenCalledWith(
      "/opt/bin/hermes-custom",
      ["chat", "--quiet", "--query", "Say exactly: configured binary OK."],
      expect.any(Object),
    );
  });

  it("returns from sendTurn before the Hermes process resolves", async () => {
    const pending = makePendingHermesExecFile();
    const threadId = ThreadId.makeUnsafe("thread-hermes-async-test");

    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "hermes",
          cwd: "/tmp/synara-hermes",
          runtimeMode: "full-access",
        });

        const result = yield* adapter.sendTurn({
          threadId,
          input: "Say exactly: async done.",
        });
        expect(result.threadId).toBe(threadId);
        const started = yield* Effect.promise(() => pending.started).pipe(
          Effect.timeoutOption(2_000),
        );
        expect(started._tag).toBe("Some");
        expect(pending.execFile).toHaveBeenCalledTimes(1);

        const beforeCompletion = yield* adapter.readThread(threadId);
        expect(beforeCompletion.turns[0]?.items).toEqual([]);

        pending.resolve({ stdout: "async done.\n", stderr: "" });
        yield* Effect.sleep("20 millis");
        return yield* adapter.readThread(threadId);
      }).pipe(
        Effect.provide(
          makeHermesAdapterLive({
            execFile: pending.execFile,
          }),
        ),
      ),
    );

    expect(snapshot.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemType: "assistant_message", text: "async done." }),
      ]),
    );
  });

  it("aborts the active Hermes process when interrupting a turn", async () => {
    const pending = makePendingHermesExecFile();
    const threadId = ThreadId.makeUnsafe("thread-hermes-interrupt-test");

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "hermes",
          cwd: "/tmp/synara-hermes",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Keep running.",
        });
        const started = yield* Effect.promise(() => pending.started).pipe(
          Effect.timeoutOption(2_000),
        );
        expect(started._tag).toBe("Some");
        const execOptions = pending.execFile.mock.calls[0]?.[2];
        expect(execOptions?.signal?.aborted).toBe(false);

        yield* adapter.interruptTurn(threadId);
        expect(execOptions?.signal?.aborted).toBe(true);
        yield* Effect.sleep("20 millis");
        const sessions = yield* adapter.listSessions();
        return sessions.find((candidate) => candidate.threadId === threadId);
      }).pipe(
        Effect.provide(
          makeHermesAdapterLive({
            execFile: pending.execFile,
          }),
        ),
      ),
    );

    expect(session?.status).toBe("error");
    expect(session?.lastError).toContain("Hermes process aborted");
  });
});
