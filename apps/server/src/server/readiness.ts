import { Deferred, Effect } from "effect";

export interface ServerReadinessSnapshot {
  readonly httpListening: boolean;
  readonly pushBusReady: boolean;
  readonly keybindingsReady: boolean;
  readonly terminalSubscriptionsReady: boolean;
  readonly orchestrationSubscriptionsReady: boolean;
  readonly startupReady: boolean;
}

export interface ServerReadiness {
  readonly awaitServerReady: Effect.Effect<void>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly markPushBusReady: Effect.Effect<void>;
  readonly markKeybindingsReady: Effect.Effect<void>;
  readonly markTerminalSubscriptionsReady: Effect.Effect<void>;
  readonly markOrchestrationSubscriptionsReady: Effect.Effect<void>;
  readonly getSnapshot: Effect.Effect<ServerReadinessSnapshot>;
}

export const makeServerReadiness = Effect.gen(function* () {
  const httpListening = yield* Deferred.make<void>();
  const pushBusReady = yield* Deferred.make<void>();
  const keybindingsReady = yield* Deferred.make<void>();
  const terminalSubscriptionsReady = yield* Deferred.make<void>();
  const orchestrationSubscriptionsReady = yield* Deferred.make<void>();
  const status = {
    httpListening: false,
    pushBusReady: false,
    keybindingsReady: false,
    terminalSubscriptionsReady: false,
    orchestrationSubscriptionsReady: false,
  };

  const complete = (deferred: Deferred.Deferred<void>, key: keyof typeof status) =>
    Effect.gen(function* () {
      status[key] = true;
      yield* Deferred.succeed(deferred, undefined);
    }).pipe(Effect.asVoid, Effect.orDie);

  return {
    awaitServerReady: Effect.all([
      Deferred.await(httpListening),
      Deferred.await(pushBusReady),
      Deferred.await(keybindingsReady),
      Deferred.await(terminalSubscriptionsReady),
      Deferred.await(orchestrationSubscriptionsReady),
    ]).pipe(Effect.asVoid),
    markHttpListening: complete(httpListening, "httpListening"),
    markPushBusReady: complete(pushBusReady, "pushBusReady"),
    markKeybindingsReady: complete(keybindingsReady, "keybindingsReady"),
    markTerminalSubscriptionsReady: complete(
      terminalSubscriptionsReady,
      "terminalSubscriptionsReady",
    ),
    markOrchestrationSubscriptionsReady: complete(
      orchestrationSubscriptionsReady,
      "orchestrationSubscriptionsReady",
    ),
    getSnapshot: Effect.sync(() => ({
      ...status,
      startupReady:
        status.httpListening &&
        status.pushBusReady &&
        status.keybindingsReady &&
        status.terminalSubscriptionsReady &&
        status.orchestrationSubscriptionsReady,
    })),
  } satisfies ServerReadiness;
});
