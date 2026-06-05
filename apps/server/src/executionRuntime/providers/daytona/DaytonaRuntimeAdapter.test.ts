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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { Cause, Duration, Effect, Fiber, Layer, ManagedRuntime, Ref } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";

import { DaytonaApiError } from "./DaytonaErrors.ts";
import { DaytonaRuntimeAdapter } from "./DaytonaRuntimeAdapter.ts";
import { makeDaytonaRuntimeAdapterServiceLive } from "./DaytonaRuntimeAdapter.ts";
import { FakeDaytonaSandboxClientLive } from "./FakeDaytonaSandboxClient.ts";
import { DaytonaRuntimeAdapterLive } from "./DaytonaRuntimeAdapter.ts";
import {
  DaytonaSandboxClient,
  type DaytonaExecInput,
  type DaytonaSandboxClientShape,
} from "./DaytonaSandboxClient.ts";

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
        return yield* adapter.provision({
          threadId: "t-1",
          ports: [],
          snapshotId: null,
        });
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
        const context = yield* adapter.provision({
          threadId: "t-3",
          ports: [],
          snapshotId: null,
        });
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
        adapter.provision({
          threadId: "t-4",
          ports: [],
          snapshotId: "snap-prior",
        }),
      ),
    );
    expect(context.instance.provider).toBe("daytona");
    expect(context.instance.status).toBe("running");
  });
});

describe("DaytonaRuntimeAdapter codex auth injection", () => {
  const tempDirs: string[] = [];
  const recordedExecs: DaytonaExecInput[] = [];

  // A recording client: `create` returns a fixed sandbox, `exec` records its
  // input and reports success (so `discoverRoot`'s `pwd` resolves), and the rest
  // are unused no-ops. This isolates the adapter's provision-time injection.
  // `isRemote` toggles whether the client claims its sandbox is a real remote one
  // — the gate the adapter uses to decide whether to inject host credentials.
  // `codexVersion` controls the `codex --version` probe: a string answers with a
  // zero exit, `null` answers with a non-zero exit (codex absent).
  const makeRecordingClientLayer = (
    isRemote: boolean,
    codexVersion: string | null = "codex-cli 0.50.0",
  ) =>
    Layer.succeed(DaytonaSandboxClient, {
      isRemoteSandbox: () => isRemote,
      create: () => Effect.succeed({ id: "sb-rec", status: "running", rootPath: "/work" }),
      exec: (_sandboxId, input) =>
        Effect.sync(() => {
          recordedExecs.push(input);
          if (input.command === "pwd") {
            return { stdout: "/work\n", stderr: "", exitCode: 0 };
          }
          if (input.command === "codex" && input.args[0] === "--version") {
            return codexVersion === null
              ? { stdout: "", stderr: "not found\n", exitCode: 127 }
              : { stdout: `${codexVersion}\n`, stderr: "", exitCode: 0 };
          }
          return { stdout: "codex-auth-injected\n", stderr: "", exitCode: 0 };
        }),
      startSession: () => Effect.die("unused" as never),
      exposePort: () => Effect.die("unused" as never),
      snapshot: () => Effect.succeed({ snapshotId: "snap-rec" }),
      refreshActivity: () => Effect.void,
      stop: () => Effect.void,
      getStatus: () => Effect.succeed(null),
      destroy: () => Effect.void,
    } satisfies DaytonaSandboxClientShape);

  const makeCodexHome = (authJson: string | null): string => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    tempDirs.push(home);
    if (authJson !== null) {
      writeFileSync(path.join(home, "auth.json"), authJson, "utf8");
    }
    return home;
  };

  afterEach(() => {
    recordedExecs.length = 0;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects host auth.json (and minimal config) into the sandbox during provision", async () => {
    const home = makeCodexHome('{"tokens":{"access_token":"abc"}}');
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(true)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({
            threadId: "t-auth",
            ports: [],
            snapshotId: null,
          }),
        ),
      );
    } finally {
      await runtime.dispose();
    }

    const injectionExecs = recordedExecs.filter((exec) => exec.command === "bash");
    // One exec writes auth.json, one writes the minimal config — both via bash -lc.
    const authInject = injectionExecs.find((exec) =>
      exec.args.some((arg) => arg.includes('"$HOME/.codex/auth.json"')),
    );
    expect(authInject).toBeDefined();
    expect(authInject?.args[0]).toBe("-lc");
    const b64 = authInject?.args[2] as string;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe('{"tokens":{"access_token":"abc"}}');
    expect(
      injectionExecs.some((exec) => exec.args.some((arg) => arg.includes("config.toml"))),
    ).toBe(true);
  });

  it("skips injection when the host has no codex login", async () => {
    const home = makeCodexHome(null);
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(true)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({
            threadId: "t-noauth",
            ports: [],
            snapshotId: null,
          }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
    // No bash injection execs ran (only `pwd` readiness + the codex version probe).
    expect(recordedExecs.some((exec) => exec.command === "bash")).toBe(false);
  });

  it("never injects into a local (non-remote) sandbox even when host auth exists", async () => {
    // The fake/local client shares the host's real `$HOME`; injecting would
    // clobber the developer's own `~/.codex/auth.json`. The remote gate keeps the
    // local path side-effect free regardless of a present host login.
    const home = makeCodexHome('{"tokens":{"access_token":"abc"}}');
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(false)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({
            threadId: "t-local",
            ports: [],
            snapshotId: null,
          }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
    expect(recordedExecs.every((exec) => exec.command === "pwd")).toBe(true);
  });

  it("probes codex --version on a remote sandbox during provision", async () => {
    const home = makeCodexHome('{"tokens":{"access_token":"abc"}}');
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(true, "codex-cli 0.50.0")),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({ threadId: "t-ver", ports: [], snapshotId: null }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
    expect(
      recordedExecs.some((exec) => exec.command === "codex" && exec.args[0] === "--version"),
    ).toBe(true);
  });

  it("fails provisioning when the snapshot has no codex", async () => {
    const home = makeCodexHome('{"tokens":{"access_token":"abc"}}');
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(true, null)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const exit = await runtime.runPromiseExit(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({ threadId: "t-nocodex", ports: [], snapshotId: null }),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(DaytonaApiError);
        expect((error as DaytonaApiError).detail).toContain("no compatible codex");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("fails provisioning when the snapshot codex is too old", async () => {
    const home = makeCodexHome('{"tokens":{"access_token":"abc"}}');
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(true, "codex-cli 0.1.0")),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const exit = await runtime.runPromiseExit(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({ threadId: "t-old", ports: [], snapshotId: null }),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(DaytonaApiError);
        expect((error as DaytonaApiError).detail).toContain("too old");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses to snapshot a sandbox with injected credentials", async () => {
    const home = makeCodexHome('{"tokens":{"access_token":"abc"}}');
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(true)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const exit = await runtime.runPromiseExit(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          Effect.gen(function* () {
            const context = yield* adapter.provision({
              threadId: "t-taint",
              ports: [],
              snapshotId: null,
            });
            return yield* adapter.snapshot(context.instance.id, "label");
          }),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(DaytonaApiError);
        expect((error as DaytonaApiError).operation).toBe("snapshot");
        expect((error as DaytonaApiError).detail).toContain("injected codex credentials");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("allows snapshotting a sandbox with no injected credentials", async () => {
    // No host login -> no injection -> not tainted -> snapshot is allowed.
    const home = makeCodexHome(null);
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(true)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const result = await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          Effect.gen(function* () {
            const context = yield* adapter.provision({
              threadId: "t-clean",
              ports: [],
              snapshotId: null,
            });
            return yield* adapter.snapshot(context.instance.id, "label");
          }),
        ),
      );
      expect(result.snapshotId).toBe("snap-rec");
    } finally {
      await runtime.dispose();
    }
  });

  it("re-injects fresh auth on resume", async () => {
    const home = makeCodexHome('{"tokens":{"access_token":"abc"}}');
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(makeRecordingClientLayer(true)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          Effect.gen(function* () {
            const context = yield* adapter.provision({
              threadId: "t-resume",
              ports: [],
              snapshotId: null,
            });
            recordedExecs.length = 0;
            yield* adapter.reinjectCredentials(context.instance.id);
          }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
    const authRewrite = recordedExecs.find(
      (exec) =>
        exec.command === "bash" &&
        exec.args.some((arg) => arg.includes('"$HOME/.codex/auth.json"')),
    );
    expect(authRewrite).toBeDefined();
  });
});

describe("DaytonaRuntimeAdapter repo clone on provision", () => {
  const tempDirs: string[] = [];
  const recordedExecs: DaytonaExecInput[] = [];

  const repoSource = {
    repoUrl: "https://github.com/Tbsheff/synara.git",
    ref: "main",
    tokenizedUrl: "https://x-access-token:gho_secrettoken@github.com/Tbsheff/synara.git",
    targetSubdir: "synara",
  } as const;

  // A recording client where `exec` records every input. `pwd` reports the
  // sandbox root, `codex --version` answers a supported version, and the clone
  // (a `bash -lc git clone ...`) succeeds unless `cloneExit` is non-zero, which
  // simulates a private-repo 403 to exercise the redacted-error path.
  const makeRecordingClientLayer = (isRemote: boolean, cloneExit = 0) =>
    Layer.succeed(DaytonaSandboxClient, {
      isRemoteSandbox: () => isRemote,
      create: () => Effect.succeed({ id: "sb-clone", status: "running", rootPath: "/root" }),
      exec: (_sandboxId, input) =>
        Effect.sync(() => {
          recordedExecs.push(input);
          if (input.command === "pwd") {
            return { stdout: "/root\n", stderr: "", exitCode: 0 };
          }
          if (input.command === "codex" && input.args[0] === "--version") {
            return { stdout: "codex-cli 0.50.0\n", stderr: "", exitCode: 0 };
          }
          // The clone bash command; the script references the secret as a base64
          // arg, so a failing git would echo the tokenized URL — assert it never
          // survives into the surfaced error by emitting it on stderr here.
          const isClone = input.args.some((arg) => arg.includes("git clone"));
          if (isClone) {
            return cloneExit === 0
              ? { stdout: "git-workspace-ready\n", stderr: "", exitCode: 0 }
              : {
                  stdout: "",
                  stderr: `fatal: could not read from ${repoSource.tokenizedUrl}\n`,
                  exitCode: 128,
                };
          }
          return { stdout: "codex-auth-injected\n", stderr: "", exitCode: 0 };
        }),
      startSession: () => Effect.die("unused" as never),
      exposePort: () => Effect.die("unused" as never),
      snapshot: () => Effect.succeed({ snapshotId: "snap-rec" }),
      refreshActivity: () => Effect.void,
      stop: () => Effect.void,
      getStatus: () => Effect.succeed(null),
      destroy: () => Effect.void,
    } satisfies DaytonaSandboxClientShape);

  const makeCodexHome = (): string => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-home-clone-"));
    tempDirs.push(home);
    writeFileSync(path.join(home, "auth.json"), '{"tokens":{"access_token":"abc"}}', "utf8");
    return home;
  };

  afterEach(() => {
    recordedExecs.length = 0;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clones the repo into <root>/<subdir> and makes it the recorded root", async () => {
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: makeCodexHome() } }).pipe(
        Layer.provide(makeRecordingClientLayer(true)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    let context;
    try {
      context = await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({ threadId: "t-clone", ports: [], snapshotId: null, repoSource }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
    // The agent cwd is the clone dir, not the bare sandbox root.
    expect(context.rootPath).toBe("/root/synara");
    expect(context.instance.rootPath).toBe("/root/synara");

    const cloneExec = recordedExecs.find((exec) =>
      exec.args.some((arg) => arg.includes("git clone")),
    );
    expect(cloneExec).toBeDefined();
    expect(cloneExec?.command).toBe("bash");
    expect(cloneExec?.args[0]).toBe("-lc");
    // The clone script strips the token: origin is rewritten to the clean URL and
    // the ref is checked out.
    expect(cloneExec?.args[1]).toContain("remote set-url origin");
    expect(cloneExec?.args[1]).toContain('checkout -B "$ref"');
  });

  it("does not persist the token in the visible clone command", async () => {
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: makeCodexHome() } }).pipe(
        Layer.provide(makeRecordingClientLayer(true)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({ threadId: "t-clone-tok", ports: [], snapshotId: null, repoSource }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
    const cloneExec = recordedExecs.find((exec) =>
      exec.args.some((arg) => arg.includes("git clone")),
    );
    // The raw token must not appear in the script (args[0]/args[1]); it only lives
    // in the opaque base64 positional arg passed to bash.
    expect(cloneExec?.args[1]).not.toContain("gho_secrettoken");
    expect(cloneExec?.args[0]).not.toContain("gho_secrettoken");
  });

  it("taints the cloned sandbox so snapshot refuses it", async () => {
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: makeCodexHome() } }).pipe(
        Layer.provide(makeRecordingClientLayer(true)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const exit = await runtime.runPromiseExit(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          Effect.gen(function* () {
            const context = yield* adapter.provision({
              threadId: "t-clone-taint",
              ports: [],
              snapshotId: null,
              repoSource,
            });
            return yield* adapter.snapshot(context.instance.id, "label");
          }),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(DaytonaApiError);
        expect((error as DaytonaApiError).operation).toBe("snapshot");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("never clones into a local (non-remote) sandbox", async () => {
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: makeCodexHome() } }).pipe(
        Layer.provide(makeRecordingClientLayer(false)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    let context;
    try {
      context = await runtime.runPromise(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({ threadId: "t-clone-local", ports: [], snapshotId: null, repoSource }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
    // Local path shares the host FS: no clone, root unchanged from discovery.
    expect(recordedExecs.some((exec) => exec.args.some((arg) => arg.includes("git clone")))).toBe(
      false,
    );
    expect(context.rootPath).toBe("/root");
  });

  it("fails provisioning with a redacted error when the clone fails", async () => {
    const runtime = ManagedRuntime.make(
      makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: makeCodexHome() } }).pipe(
        Layer.provide(makeRecordingClientLayer(true, 128)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const exit = await runtime.runPromiseExit(
        Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
          adapter.provision({ threadId: "t-clone-fail", ports: [], snapshotId: null, repoSource }),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(DaytonaApiError);
        const detail = (error as DaytonaApiError).detail;
        expect(detail).toContain("failed to clone the project repo");
        // The token (and tokenized URL) must be scrubbed from the surfaced error.
        expect(detail).not.toContain("gho_secrettoken");
        expect(detail).not.toContain(repoSource.tokenizedUrl);
      }
    } finally {
      await runtime.dispose();
    }
  });
});

describe("DaytonaRuntimeAdapter provision cold-start", () => {
  // A client whose `pwd` fails the first `pwdFailures` times (sandbox not yet
  // running), then reports the root. The exec log is a Ref so the TestClock-driven
  // tests can read it without racing the recording. `codex --version` always
  // answers a supported version with a zero exit; bash injection execs succeed.
  const makeBackoffClientLayer = (pwdFailures: number, execLog: Ref.Ref<ReadonlyArray<string>>) =>
    Effect.gen(function* () {
      const pwdCalls = yield* Ref.make(0);
      return Layer.succeed(DaytonaSandboxClient, {
        isRemoteSandbox: () => true,
        create: () =>
          Effect.succeed({ id: "sb-backoff", status: "running", rootPath: "/fallback" }),
        exec: (_sandboxId, input) =>
          Effect.gen(function* () {
            yield* Ref.update(execLog, (log) => [...log, input.command]);
            if (input.command === "pwd") {
              const attempt = yield* Ref.updateAndGet(pwdCalls, (n) => n + 1);
              return attempt <= pwdFailures
                ? { stdout: "", stderr: "starting\n", exitCode: 1 }
                : { stdout: "/work\n", stderr: "", exitCode: 0 };
            }
            if (input.command === "codex") {
              return { stdout: "codex-cli 0.50.0\n", stderr: "", exitCode: 0 };
            }
            return { stdout: "ok\n", stderr: "", exitCode: 0 };
          }),
        startSession: () => Effect.die("unused" as never),
        exposePort: () => Effect.die("unused" as never),
        snapshot: () => Effect.succeed({ snapshotId: "snap-rec" }),
        refreshActivity: () => Effect.void,
        stop: () => Effect.void,
        getStatus: () => Effect.succeed(null),
        destroy: () => Effect.void,
      } satisfies DaytonaSandboxClientShape);
    });

  const provisionEffect = Effect.flatMap(DaytonaRuntimeAdapter.asEffect(), (adapter) =>
    adapter.provision({ threadId: "t-cold", ports: [], snapshotId: null }),
  );

  effectIt.effect(
    "detects a sandbox ready after 2 pwd failures within the exponential ramp (<700ms)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const execLog = yield* Ref.make<ReadonlyArray<string>>([]);
          const clientLayer = yield* makeBackoffClientLayer(2, execLog);
          const adapterLayer = makeDaytonaRuntimeAdapterServiceLive({
            env: { CODEX_HOME: "/nonexistent-codex-home" },
          }).pipe(Layer.provide(clientLayer), Layer.provideMerge(NodeServices.layer));

          const fiber = yield* provisionEffect.pipe(
            Effect.provide(adapterLayer),
            Effect.forkScoped({ startImmediately: true }),
          );

          // First pwd fails immediately; backoff sleeps 100ms before retry 2, then
          // 200ms before retry 3 which succeeds. Total ramp wait = 300ms. The flat
          // 2s x40 loop would have waited 4s for two failures.
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(100));
          yield* TestClock.adjust(Duration.millis(200));

          const context = yield* Fiber.join(fiber);
          expect(context.rootPath).toBe("/work");
          const log = yield* Ref.get(execLog);
          expect(log.filter((command) => command === "pwd").length).toBe(3);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("runs codex auth injection and the codex-version probe concurrently", () =>
    Effect.gen(function* () {
      const execLog = yield* Ref.make<ReadonlyArray<string>>([]);
      // pwd succeeds on the first attempt, so the only post-discovery execs are the
      // concurrent injection (bash) and probe (codex). With a real host login the
      // injection's two bash writes and the codex probe all fire under one provision.
      const clientLayer = yield* makeBackoffClientLayer(0, execLog);
      const home = mkdtempSync(path.join(tmpdir(), "codex-home-cold-"));
      writeFileSync(path.join(home, "auth.json"), '{"tokens":{"access_token":"abc"}}', "utf8");
      const adapterLayer = makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(clientLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      try {
        const context = yield* provisionEffect.pipe(Effect.provide(adapterLayer));
        expect(context.instance.provider).toBe("daytona");
        const log = yield* Ref.get(execLog);
        expect(log.includes("bash")).toBe(true);
        expect(log.includes("codex")).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effectIt.effect("still fails fast when codex is absent even with concurrent setup", () =>
    Effect.gen(function* () {
      const execLog = yield* Ref.make<ReadonlyArray<string>>([]);
      const pwdCalls = yield* Ref.make(0);
      const clientLayer = Layer.succeed(DaytonaSandboxClient, {
        isRemoteSandbox: () => true,
        create: () => Effect.succeed({ id: "sb-nocodex", status: "running", rootPath: "/work" }),
        exec: (_sandboxId, input) =>
          Effect.gen(function* () {
            yield* Ref.update(execLog, (log) => [...log, input.command]);
            if (input.command === "pwd") {
              yield* Ref.update(pwdCalls, (n) => n + 1);
              return { stdout: "/work\n", stderr: "", exitCode: 0 };
            }
            if (input.command === "codex") {
              return { stdout: "", stderr: "not found\n", exitCode: 127 };
            }
            return { stdout: "ok\n", stderr: "", exitCode: 0 };
          }),
        startSession: () => Effect.die("unused" as never),
        exposePort: () => Effect.die("unused" as never),
        snapshot: () => Effect.succeed({ snapshotId: "snap-rec" }),
        refreshActivity: () => Effect.void,
        stop: () => Effect.void,
        getStatus: () => Effect.succeed(null),
        destroy: () => Effect.void,
      } satisfies DaytonaSandboxClientShape);
      const home = mkdtempSync(path.join(tmpdir(), "codex-home-nocodex-"));
      writeFileSync(path.join(home, "auth.json"), '{"tokens":{"access_token":"abc"}}', "utf8");
      const adapterLayer = makeDaytonaRuntimeAdapterServiceLive({ env: { CODEX_HOME: home } }).pipe(
        Layer.provide(clientLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      try {
        const exit = yield* provisionEffect.pipe(Effect.provide(adapterLayer), Effect.exit);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(DaytonaApiError);
          expect((error as DaytonaApiError).detail).toContain("no compatible codex");
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
