import { Effect, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { closeServerRuntimePipeline, startServerRuntimePipeline } from "./effectServer.ts";

describe("server runtime pipeline shutdown", () => {
  it("persists accepted provider terminal work before the engine stops", async () => {
    const order: string[] = [];
    let terminalAccepted = false;
    let terminalPersisted = false;
    let attachmentsDrained = false;
    const subscriptionsScope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      Scope.addFinalizer(
        subscriptionsScope,
        Effect.sync(() => {
          expect(terminalAccepted).toBe(true);
          terminalPersisted = true;
          order.push("reactors-drained-and-persisted");
        }),
      ),
    );

    await Effect.runPromise(
      closeServerRuntimePipeline({
        orchestrationEngine: {
          quiesce: Effect.sync(() => order.push("engine-quiesced")),
          drain: Effect.sync(() => order.push("admitted-commands-drained")),
          stop: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            expect(attachmentsDrained).toBe(true);
            order.push("engine-stopped");
          }),
        },
        providerService: {
          closeRuntimeEvents: Effect.sync(() => {
            terminalAccepted = true;
            order.push("provider-terminal-events-fenced");
          }),
        },
        managedAttachmentCleanup: {
          drain: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            attachmentsDrained = true;
            order.push("managed-attachments-drained");
          }),
        },
        subscriptionsScope,
      }),
    );

    expect(order).toEqual([
      "engine-quiesced",
      "admitted-commands-drained",
      "provider-terminal-events-fenced",
      "reactors-drained-and-persisted",
      "managed-attachments-drained",
      "engine-stopped",
    ]);
  });
});

describe("server runtime pipeline startup", () => {
  it("settles restart-orphaned turns before background reactors start", async () => {
    const order: string[] = [];
    const reactor = (name: string) => ({
      start: () => Effect.sync(() => void order.push(`${name}-started`)),
    });
    const subscriptionsScope = await Effect.runPromise(Scope.make("sequential"));

    await Effect.runPromise(
      startServerRuntimePipeline({
        orchestrationReactor: {
          start: Effect.sync(() => void order.push("runtime-journal-replayed")),
          reconcileSettledOpenTurns: Effect.sync(() => void order.push("open-turn-ledger-pruned")),
        },
        reconcileRestartStuckTurns: Effect.sync(() => void order.push("restart-turns-settled")),
        reactors: [reactor("automation-scheduler"), reactor("provider-runtime-reconciler")],
        subscriptionsScope,
      }),
    );

    expect(order).toEqual([
      "runtime-journal-replayed",
      "restart-turns-settled",
      "open-turn-ledger-pruned",
      "automation-scheduler-started",
      "provider-runtime-reconciler-started",
    ]);
  });
});
