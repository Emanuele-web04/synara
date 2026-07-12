import * as Http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { OrchestrationReadModel } from "@synara/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, beforeEach, vi } from "vitest";
import { NetService } from "@synara/shared/Net";

import { ServerConfig, type ServerConfigShape } from "./config";
import { Open, type OpenShape } from "./open";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { Server, type ServerShape } from "./effectServer";

vi.mock("./threadRetention", async () => {
  const Effect = await import("effect/Effect");
  return {
    startThreadRetentionJob: () => Effect.void,
  };
});

import { CliConfig, recordStartupHeartbeat, synaraCli, type CliConfigShape } from "./main";

const start = vi.fn(() => undefined);
const stop = vi.fn(() => undefined);
let resolvedConfig: ServerConfigShape | null = null;
const serverStart = Effect.acquireRelease(
  Effect.gen(function* () {
    resolvedConfig = yield* ServerConfig;
    start();
    return {} as unknown as Http.Server;
  }),
  () => Effect.sync(() => stop()),
);
const findAvailablePort = vi.fn((preferred: number) => Effect.succeed(preferred));
let defaultSynaraHome = "";
const tempHomes = new Set<string>();

function makeTempHome(prefix = "synara-main-test-"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempHomes.add(directory);
  return directory;
}

// Shared service layer used by this CLI test suite.
const testLayer = Layer.mergeAll(
  Layer.succeed(CliConfig, {
    cwd: "/tmp/synara-test-workspace",
    fixPath: Effect.void,
    resolveStaticDir: Effect.undefined,
  } satisfies CliConfigShape),
  Layer.succeed(NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort,
  }),
  Layer.succeed(Server, {
    start: serverStart,
    stopSignal: Effect.void,
  } satisfies ServerShape),
  Layer.succeed(Open, {
    openBrowser: (_target: string) => Effect.void,
    openInEditor: () => Effect.void,
  } satisfies OpenShape),
  AnalyticsService.layerTest,
  FetchHttpClient.layer,
  NodeServices.layer,
);

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const program = Command.runWith(synaraCli, { version: "0.0.0-test" })(args).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            SYNARA_HOME: defaultSynaraHome,
            SYNARA_NO_BROWSER: "true",
            ...env,
          },
        }),
      ),
    ),
  );
  return program as Effect.Effect<void, unknown, never>;
};

beforeEach(() => {
  vi.clearAllMocks();
  defaultSynaraHome = makeTempHome();
  resolvedConfig = null;
  start.mockImplementation(() => undefined);
  stop.mockImplementation(() => undefined);
  findAvailablePort.mockImplementation((preferred: number) => Effect.succeed(preferred));
});

afterEach(() => {
  for (const directory of tempHomes) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  tempHomes.clear();
});

it.layer(testLayer)("server CLI command", (it) => {
  it.effect("parses all CLI flags and wires scoped start/stop", () =>
    Effect.gen(function* () {
      const flagHome = makeTempHome("synara-main-flag-");

      yield* runCli([
        "--mode",
        "desktop",
        "--port",
        "4010",
        "--host",
        "0.0.0.0",
        "--home-dir",
        flagHome,
        "--dev-url",
        "http://127.0.0.1:5173",
        "--no-browser",
        "--auth-token",
        "auth-secret",
      ]);

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.mode, "desktop");
      assert.equal(resolvedConfig?.port, 4010);
      assert.equal(resolvedConfig?.host, "0.0.0.0");
      assert.equal(resolvedConfig?.baseDir, flagHome);
      assert.equal(resolvedConfig?.stateDir, path.join(flagHome, "dev"));
      assert.equal(resolvedConfig?.devUrl?.toString(), "http://127.0.0.1:5173/");
      assert.equal(resolvedConfig?.noBrowser, true);
      assert.equal(resolvedConfig?.authToken, "auth-secret");
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, false);
      assert.equal(resolvedConfig?.logProviderEvents, false);
      assert.equal(resolvedConfig?.logWebSocketEvents, false);
      assert.equal(stop.mock.calls.length, 1);
    }),
  );

  it.effect("supports --token as an alias for --auth-token", () =>
    Effect.gen(function* () {
      yield* runCli(["--token", "token-secret"]);

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.authToken, "token-secret");
    }),
  );

  it.effect("uses env fallbacks when flags are not provided", () =>
    Effect.gen(function* () {
      const envHome = makeTempHome("synara-main-env-");

      yield* runCli([], {
        SYNARA_MODE: "desktop",
        SYNARA_PORT: "4999",
        SYNARA_HOST: "100.88.10.4",
        SYNARA_HOME: envHome,
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        SYNARA_NO_BROWSER: "true",
        SYNARA_AUTH_TOKEN: "env-token",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.mode, "desktop");
      assert.equal(resolvedConfig?.port, 4999);
      assert.equal(resolvedConfig?.host, "100.88.10.4");
      assert.equal(resolvedConfig?.baseDir, envHome);
      assert.equal(resolvedConfig?.stateDir, path.join(envHome, "dev"));
      assert.equal(resolvedConfig?.devUrl?.toString(), "http://localhost:5173/");
      assert.equal(resolvedConfig?.noBrowser, true);
      assert.equal(resolvedConfig?.authToken, "env-token");
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, false);
      assert.equal(resolvedConfig?.logProviderEvents, false);
      assert.equal(resolvedConfig?.logWebSocketEvents, false);
      assert.equal(findAvailablePort.mock.calls.length, 0);
    }),
  );

  it.effect("prefers --mode over SYNARA_MODE", () =>
    Effect.gen(function* () {
      findAvailablePort.mockImplementation((_preferred: number) => Effect.succeed(4666));
      yield* runCli(["--mode", "web"], {
        SYNARA_MODE: "desktop",
        SYNARA_NO_BROWSER: "true",
      });

      assert.deepStrictEqual(findAvailablePort.mock.calls, [[3773]]);
      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.mode, "web");
      assert.equal(resolvedConfig?.port, 4666);
      assert.equal(resolvedConfig?.host, undefined);
    }),
  );

  it.effect("prefers --no-browser over SYNARA_NO_BROWSER", () =>
    Effect.gen(function* () {
      yield* runCli(["--no-browser"], {
        SYNARA_NO_BROWSER: "false",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.noBrowser, true);
    }),
  );

  it.effect("uses dynamic port discovery in web mode when port is omitted", () =>
    Effect.gen(function* () {
      findAvailablePort.mockImplementation((_preferred: number) => Effect.succeed(5444));
      yield* runCli([]);

      assert.deepStrictEqual(findAvailablePort.mock.calls, [[3773]]);
      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 5444);
      assert.equal(resolvedConfig?.mode, "web");
    }),
  );

  it.effect("uses fixed localhost defaults in desktop mode", () =>
    Effect.gen(function* () {
      yield* runCli([], {
        SYNARA_MODE: "desktop",
        SYNARA_NO_BROWSER: "true",
      });

      assert.equal(findAvailablePort.mock.calls.length, 0);
      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 3773);
      assert.equal(resolvedConfig?.host, "127.0.0.1");
      assert.equal(resolvedConfig?.mode, "desktop");
    }),
  );

  it.effect("allows overriding desktop host with --host", () =>
    Effect.gen(function* () {
      yield* runCli(["--host", "0.0.0.0"], {
        SYNARA_MODE: "desktop",
        SYNARA_NO_BROWSER: "true",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.mode, "desktop");
      assert.equal(resolvedConfig?.host, "0.0.0.0");
    }),
  );

  it.effect("supports CLI and env for bootstrap/provider-log/websocket toggles", () =>
    Effect.gen(function* () {
      yield* runCli(["--auto-bootstrap-project-from-cwd"], {
        SYNARA_MODE: "desktop",
        SYNARA_LOG_PROVIDER_EVENTS: "true",
        SYNARA_LOG_WS_EVENTS: "false",
        SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        SYNARA_NO_BROWSER: "true",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, true);
      assert.equal(resolvedConfig?.logProviderEvents, true);
      assert.equal(resolvedConfig?.logWebSocketEvents, false);
    }),
  );

  it.effect("records a startup heartbeat with thread/project counts", () =>
    Effect.gen(function* () {
      const recordTelemetry = vi.fn(
        (_event: string, _properties?: Readonly<Record<string, unknown>>) => Effect.void,
      );
      const getCounts = vi.fn(() =>
        Effect.succeed({
          threadCount: 2,
          projectCount: 1,
        }),
      );

      yield* recordStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [] as OrchestrationReadModel["projects"],
              threads: [] as OrchestrationReadModel["threads"],
              updatedAt: new Date(0).toISOString(),
            }),
          getCommandReadModel: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [] as OrchestrationReadModel["projects"],
              threads: [] as OrchestrationReadModel["threads"],
              updatedAt: new Date(0).toISOString(),
            }),
          getCounts,
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getShellSnapshot: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          listGeneratedImageActivitiesByTurn: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.die("unused"),
          findSyntheticSubagentParentThread: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailForExportById: () => Effect.die("unused"),
          getThreadDetailSnapshotById: () => Effect.die("unused"),
        }),
        Effect.provideService(AnalyticsService, {
          record: recordTelemetry,
          flush: Effect.void,
        }),
      );

      assert.deepEqual(recordTelemetry.mock.calls[0], [
        "server.boot.heartbeat",
        {
          threadCount: 2,
          projectCount: 1,
        },
      ]);
    }),
  );

  it.effect("does not start server for invalid --mode values", () =>
    Effect.gen(function* () {
      yield* runCli(["--mode", "invalid"]);

      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );

  it.effect("does not start server for invalid --dev-url values", () =>
    Effect.gen(function* () {
      yield* runCli(["--dev-url", "not-a-url"]).pipe(Effect.catch(() => Effect.void));

      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );

  it.effect("does not start server for out-of-range --port values", () =>
    Effect.gen(function* () {
      yield* runCli(["--port", "70000"]);

      // effect/unstable/cli renders help/errors for parse failures and returns success.
      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );
});
