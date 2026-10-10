import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentProfileId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Deferred, Effect, Layer, Scope, Stream } from "effect";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore.ts";
import {
  AgentProfileService,
  AgentProfileServiceLive,
} from "../../externalAgents/AgentProfileService.ts";
import { AgentProfileRepositoryLive } from "../../externalAgents/AgentProfileRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeExternalAgentAdapter } from "./ExternalAgentAdapter.ts";

it("runs a profile-backed ACP turn and refuses mismatched identities before dispatch", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/external-agent.mjs", import.meta.url));
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "synara-external-integration-" });
  const dependencies = Layer.mergeAll(
    AgentProfileServiceLive.pipe(Layer.provideMerge(AgentProfileRepositoryLive)),
    ServerSecretStoreLive,
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const profiles = yield* AgentProfileService;
      const created = yield* profiles.createProfile({
        name: "Fixture",
        displayName: "Fixture",
        connectorKind: "acp",
        launch: { kind: "command", command: process.execPath, args: [fixture] },
        credentialRefs: [],
        provenance: { source: "manual" },
      });
      const adapter = yield* makeExternalAgentAdapter();
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const scope = yield* Scope.Scope;
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(completed, undefined);
            if (event.payload.state === "cancelled") yield* Deferred.succeed(cancelled, undefined);
          }
        }),
      ).pipe(Effect.forkIn(scope));
      yield* Effect.yieldNow;
      const threadId = ThreadId.makeUnsafe("external-integration");
      const selection = {
        provider: "external" as const,
        instanceId: "external" as const,
        profileId: created.profile.profileId,
        revisionId: created.revision.revisionId,
        model: "default",
      };
      const session = yield* adapter.startSession({
        threadId,
        provider: "external",
        providerInstanceId: "external",
        cwd: path.dirname(fixture),
        runtimeMode: "full-access",
        modelSelection: selection,
      });
      expect(session.resumeCursor).toMatchObject({
        schemaVersion: 2,
        profileId: selection.profileId,
        revisionId: selection.revisionId,
      });
      const mismatch = yield* adapter
        .sendTurn({
          threadId,
          input: "Wrong profile",
          modelSelection: { ...selection, profileId: AgentProfileId.makeUnsafe("other-profile") },
        })
        .pipe(Effect.flip);
      expect(mismatch.message).toMatch(/profile and revision/);
      yield* adapter.sendTurn({ threadId, input: "Hello", modelSelection: selection });
      yield* Deferred.await(completed).pipe(Effect.timeout("10 seconds"));
      expect(events.some((event) => event.type === "content.delta")).toBe(true);
      const starts = events.filter((event) => event.type === "item.started");
      const ends = events.filter((event) => event.type === "item.completed");
      expect(starts.length).toBeGreaterThan(0);
      expect(ends.map((event) => event.itemId)).toEqual(starts.map((event) => event.itemId));
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "completed",
      });
      const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      expect(rollback.message).toMatch(/rewind native history/);
      const hanging = yield* adapter.sendTurn({
        threadId,
        input: "hang",
        modelSelection: selection,
      });
      const overlapping = yield* adapter
        .sendTurn({ threadId, input: "overlap", modelSelection: selection })
        .pipe(Effect.flip);
      expect(overlapping.message).toMatch(/already running/);
      yield* adapter.interruptTurn(threadId, hanging.turnId);
      yield* Deferred.await(cancelled).pipe(Effect.timeout("10 seconds"));
      expect(
        events.filter(
          (event) => event.type === "turn.completed" && event.turnId === hanging.turnId,
        ),
      ).toHaveLength(1);
      yield* adapter.stopAll();
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
  );
}, 20_000);
