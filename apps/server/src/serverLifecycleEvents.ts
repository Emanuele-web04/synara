import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";

import type { ProjectId, ThreadId } from "@t3tools/contracts";

export interface ServerLifecycleWelcomePayload {
  readonly cwd: string;
  readonly homeDir: string;
  readonly projectName: string;
  readonly bootstrapProjectId?: ProjectId;
  readonly bootstrapThreadId?: ThreadId;
}

export interface ServerLifecycleReadyPayload {
  readonly at: string;
}

export type ServerLifecycleEvent =
  | {
      readonly sequence: number;
      readonly type: "welcome";
      readonly payload: ServerLifecycleWelcomePayload;
    }
  | {
      readonly sequence: number;
      readonly type: "ready";
      readonly payload: ServerLifecycleReadyPayload;
    };

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleEvent, { type: "ready" }>, "sequence">;

export interface ServerLifecycleSnapshot {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleEvent>;
}

export interface ServerLifecycleEventsShape {
  readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleEvent>;
  readonly snapshot: Effect.Effect<ServerLifecycleSnapshot>;
  readonly stream: Stream.Stream<ServerLifecycleEvent>;
}

export class ServerLifecycleEvents extends ServiceMap.Service<
  ServerLifecycleEvents,
  ServerLifecycleEventsShape
>()("t3/serverLifecycleEvents") {}

export const ServerLifecycleEventsLive = Layer.effect(
  ServerLifecycleEvents,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<ServerLifecycleEvent>();
    const state = yield* Ref.make<ServerLifecycleSnapshot>({
      sequence: 0,
      events: [],
    });

    const publish: ServerLifecycleEventsShape["publish"] = (event) =>
      Ref.modify(state, (current) => {
        const nextSequence = current.sequence + 1;
        const nextEvent = {
          ...event,
          sequence: nextSequence,
        } satisfies ServerLifecycleEvent;
        const nextEvents = [
          nextEvent,
          ...current.events.filter((entry) => entry.type !== nextEvent.type),
        ];
        return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
      }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event)));

    return {
      publish,
      snapshot: Ref.get(state),
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies ServerLifecycleEventsShape;
  }),
);

export function getWelcomeEvent(
  snapshot: ServerLifecycleSnapshot,
): Extract<ServerLifecycleEvent, { type: "welcome" }> | null {
  return snapshot.events.find((event) => event.type === "welcome") ?? null;
}
