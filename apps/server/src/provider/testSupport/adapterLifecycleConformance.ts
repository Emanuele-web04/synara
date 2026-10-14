import assert from "node:assert/strict";
import {
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
} from "@synara/contracts";
import { Effect } from "effect";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

import { assertProviderAdapterConformance } from "../providerAdapterConformance.ts";

/** Exercise the public ownership contract, independent of the native transport. */
export function assertAdapterCleanupConformance<E>(
  adapter: ProviderAdapterShape<E>,
  input: Omit<ProviderSessionStartInput, "threadId">,
): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    assertProviderAdapterConformance(adapter);
    const first = ThreadId.makeUnsafe("conformance-first");
    const second = ThreadId.makeUnsafe("conformance-second");
    yield* adapter.stopSession(first);
    yield* adapter.startSession({ ...input, threadId: first });
    yield* adapter.startSession({ ...input, threadId: second });
    assert.equal(yield* adapter.hasSession(first), true, "start must acquire ownership");
    assert.equal(yield* adapter.hasSession(second), true);
    yield* adapter.stopSession(first);
    yield* adapter.stopSession(first);
    assert.equal(yield* adapter.hasSession(first), false, "stop must release ownership");
    assert.equal(yield* adapter.hasSession(second), true, "stop must preserve other sessions");
    yield* adapter.stopAll();
    yield* adapter.stopAll();
    assert.equal(yield* adapter.hasSession(second), false, "stopAll must release every session");
    assert.deepEqual(yield* adapter.listSessions(), []);
  });
}

/** Check a collected, fenced event sequence; observation length belongs to the transport harness. */
export function assertTerminalOutcomeConformance(
  events: ReadonlyArray<ProviderRuntimeEvent>,
): void {
  const outcomes = new Set<string>();
  const starts = new Set<string>();
  for (const event of events) {
    if (event.type === "turn.started") {
      assert.ok(event.turnId, "started turns must identify their turn");
      starts.add(JSON.stringify([event.threadId, event.lifecycleGeneration, event.turnId]));
    }
    if (event.type !== "turn.completed" && event.type !== "turn.aborted") continue;
    assert.ok(event.turnId, "terminal outcomes must identify their turn");
    const key = JSON.stringify([event.threadId, event.lifecycleGeneration, event.turnId]);
    assert.equal(outcomes.has(key), false, `duplicate terminal outcome for ${event.turnId}`);
    outcomes.add(key);
  }
  for (const key of starts)
    assert.ok(outcomes.has(key), `started turn must have a terminal outcome: ${key}`);
  assert.ok(outcomes.size > 0, "the observed lifecycle must settle a turn");
}

export function assertSessionTeardownConformance(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  threadId: ThreadId,
): void {
  const exitedGenerations = new Set<ProviderRuntimeEvent["lifecycleGeneration"]>();
  for (const event of events) {
    if (event.threadId !== threadId) continue;
    assert.equal(
      exitedGenerations.has(event.lifecycleGeneration),
      false,
      "a stopped lifecycle generation must not emit further runtime events",
    );
    if (event.type === "session.exited") exitedGenerations.add(event.lifecycleGeneration);
  }
  assert.ok(exitedGenerations.size > 0, "the observation must include the session exit fence");
}
