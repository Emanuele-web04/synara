import { describe, expect, it } from "vitest";
import { ThreadId, type ComputerEvent } from "@synara/contracts";
import { ComputerEventInterests } from "./computerEventInterests.ts";

const clients = Array.from({ length: 10_000 }, () => ({}));
const stateEvent = (threadId: string) =>
  ({
    type: "computer.thread-state",
    state: { threadId: ThreadId.makeUnsafe(threadId) },
  }) as ComputerEvent;

describe("ComputerEventInterests", () => {
  it("routes thread snapshots only to interested clients and forgets disconnected clients", () => {
    const interests = new ComputerEventInterests();
    interests.watch(clients[1]!, "thread-a");
    interests.watch(clients[2]!, "thread-b");
    expect(interests.accepts(clients[1]!, stateEvent("thread-a"))).toBe(true);
    expect(interests.accepts(clients[1]!, stateEvent("thread-b"))).toBe(false);
    expect(interests.accepts(clients[2]!, stateEvent("thread-a"))).toBe(false);
    expect(interests.accepts(clients[1]!, { type: "computer.windows-changed", windows: [] })).toBe(
      true,
    );
    interests.forget(clients[1]!);
    expect(interests.accepts(clients[1]!, stateEvent("thread-a"))).toBe(false);
  });

  it("preserves live clients through reconnect churn and bounds per-client history", () => {
    const interests = new ComputerEventInterests();
    interests.watch(clients[0]!, "thread");
    for (let i = 0; i < 256; i += 1) interests.watch(clients[i + 1]!, "thread");
    expect(interests.accepts(clients[0]!, stateEvent("thread"))).toBe(true);
    for (let i = 0; i < 65; i += 1) interests.watch(clients[9999]!, `thread-${i}`);
    expect(interests.accepts(clients[9999]!, stateEvent("thread-0"))).toBe(false);
    expect(interests.accepts(clients[9999]!, stateEvent("thread-64"))).toBe(true);
  });
});

it("retains interests when a computer event stream resubscribes on the same socket", () => {
  const interests = new ComputerEventInterests();
  interests.watch(clients[42]!, "thread");
  const subscribe = () => (event: ComputerEvent) => interests.accepts(clients[42]!, event);
  const firstSubscription = subscribe();
  expect(firstSubscription(stateEvent("thread"))).toBe(true);
  const replacementSubscription = subscribe();
  expect(replacementSubscription(stateEvent("thread"))).toBe(true);
  expect(replacementSubscription(stateEvent("other"))).toBe(false);
});
