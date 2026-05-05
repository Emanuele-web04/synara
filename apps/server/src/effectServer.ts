import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type { ServerSettingsError } from "@t3tools/contracts";
import { Effect, Exit, FileSystem, Layer, Path, Schema, Scope, ServiceMap } from "effect";
import { HttpRouter } from "effect/unstable/http";

import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState";
import { resolveListeningPort } from "./startupAccess";
import { ServerConfig } from "./config";
import { patchBunWebSocketCloseEventCompatibility } from "./bunWebSocketCompatibility";
import { makeEffectHttpRouteLayer } from "./http";
import { Keybindings } from "./keybindings";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor";
import { ProviderSessionReaper } from "./provider/Services/ProviderSessionReaper";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { makeServerReadiness } from "./server/readiness";
import { websocketRpcRouteLayer } from "./wsRpc";

export interface ServerShape {
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError | ServerSettingsError,
    | Scope.Scope
    | ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Keybindings
    | ServerLifecycleEvents
    | OrchestrationReactor
    | ProviderSessionReaper
    | ServerRuntimeStartup
    | ServerSettingsService
    | ThreadDeletionReactor
  >;
  readonly stopSignal: Effect.Effect<void, never>;
}

export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/effectServer/Server") {}

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const createEffectServer = Effect.fn(function* () {
  const config = yield* ServerConfig;
  const keybindings = yield* Keybindings;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const orchestrationReactor = yield* OrchestrationReactor;
  const providerSessionReaper = yield* ProviderSessionReaper;
  const runtimeStartup = yield* ServerRuntimeStartup;
  const serverSettings = yield* ServerSettingsService;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const readiness = yield* makeServerReadiness;

  yield* keybindings.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );
  yield* serverSettings.start;
  yield* readiness.markPushBusReady;
  yield* readiness.markKeybindingsReady;

  let nodeServer: http.Server | null = null;
  patchBunWebSocketCloseEventCompatibility();
  const listenOptions = config.host
    ? { host: config.host, port: config.port }
    : { port: config.port };
  const httpServer = yield* NodeHttpServer.make(() => {
    nodeServer = http.createServer();
    return nodeServer;
  }, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

  const routesLayer = Layer.mergeAll(makeEffectHttpRouteLayer(readiness), websocketRpcRouteLayer);
  const httpApp = yield* HttpRouter.toHttpEffect(routesLayer);
  yield* httpServer
    .serve(httpApp)
    .pipe(
      Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerServe", cause })),
    );

  yield* persistServerRuntimeState({
    path: config.serverRuntimeStatePath,
    state: makePersistedServerRuntimeState({
      config,
      port: resolveListeningPort(
        (nodeServer as http.Server | null)?.address() ?? null,
        config.port,
      ),
    }),
  }).pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "persistServerRuntimeState", cause }),
    ),
  );
  yield* Effect.addFinalizer(() => clearPersistedServerRuntimeState(config.serverRuntimeStatePath));
  yield* readiness.markHttpListening;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));
  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
  yield* Scope.provide(threadDeletionReactor.start(), subscriptionsScope);
  yield* Scope.provide(providerSessionReaper.start(), subscriptionsScope);
  yield* readiness.markOrchestrationSubscriptionsReady;
  yield* readiness.markTerminalSubscriptionsReady;
  yield* runtimeStartup.markCommandReady;

  yield* lifecycleEvents.publish({
    type: "welcome",
    payload: {
      cwd: config.cwd,
      homeDir: config.homeDir,
      projectName: config.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? config.cwd,
    },
  });
  yield* lifecycleEvents.publish({
    type: "ready",
    payload: { at: new Date().toISOString() },
  });

  if (!nodeServer) {
    return yield* new ServerLifecycleError({ operation: "httpServerListen" });
  }
  return nodeServer as http.Server;
});

export const ServerLive = Layer.succeed(Server, {
  start: createEffectServer() as ServerShape["start"],
  stopSignal: Effect.never,
} satisfies ServerShape);
