import { Effect, Semaphore } from "effect";

interface ExecutionEntry {
  readonly slots: Semaphore.Semaphore;
  users: number;
}

export function makeExternalMcpExecutionAdmission(slotCount: number) {
  const entries = new Map<string, ExecutionEntry>();

  const acquire = (integrationId: string) =>
    Effect.sync(() => {
      let entry = entries.get(integrationId);
      if (!entry) {
        entry = {
          slots: Semaphore.makeUnsafe(Math.max(1, Math.floor(slotCount))),
          users: 0,
        };
        entries.set(integrationId, entry);
      }
      entry.users += 1;
      return entry;
    });

  const release = (integrationId: string, entry: ExecutionEntry) =>
    Effect.sync(() => {
      entry.users -= 1;
      if (entry.users === 0 && entries.get(integrationId) === entry) {
        entries.delete(integrationId);
      }
    });

  const run = <A, E, R>(integrationId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquire(integrationId),
      (entry) => entry.slots.withPermitsIfAvailable(1)(effect),
      (entry) => release(integrationId, entry),
    );

  return {
    run,
    activeIntegrationCount: () => entries.size,
  };
}

export type ExternalMcpExecutionAdmission = ReturnType<typeof makeExternalMcpExecutionAdmission>;
