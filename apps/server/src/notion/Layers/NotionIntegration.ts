import type { NotionState, TodoStreamEvent } from "@synara/contracts";
import { Effect, Layer, PubSub } from "effect";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { NotionRuntime } from "../runtime.ts";
import { NotionIntegration } from "../Services/NotionIntegration.ts";

const STORAGE_KEY = "notion-integration-v1";
export const NotionIntegrationLive = Layer.effect(
  NotionIntegration,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const events = yield* PubSub.unbounded<TodoStreamEvent>();
    const result = yield* Effect.tryPromise(async () => {
      const runtime = new NotionRuntime({
        brokerOrigin: process.env.SYNARA_NOTION_BROKER_URL ?? null,
        load: async () => {
          const bytes = await Effect.runPromise(secrets.get(STORAGE_KEY));
          return bytes ? new TextDecoder().decode(bytes) : null;
        },
        save: async (document) => {
          await Effect.runPromise(secrets.set(STORAGE_KEY, new TextEncoder().encode(document)));
        },
        publish: (event) => {
          Effect.runSync(PubSub.publish(events, event));
        },
      });
      await runtime.init();
      return runtime;
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      const state = (): NotionState => ({
        configured: false,
        connections: [],
        mappings: [],
        changes: [],
        syncing: false,
        lastSyncedAt: null,
        syncError:
          "Notion is unavailable. Check the hosted broker configuration and protected provider storage. Existing storage was not overwritten.",
      });
      return { runtime: null, events, state };
    }
    const runtime = result.success;
    // The scoped runtime owns all work. Shutdown aborts outstanding requests and drains writes.
    const timer = setInterval(() => {
      void runtime.synchronize().catch(() => {
        /* The runtime exposes its durable-storage failure through state().syncError. */
      });
    }, 60_000);
    timer.unref();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        clearInterval(timer);
        await runtime.dispose();
      }),
    );
    return { runtime, events, state: () => runtime.state() };
  }),
);
