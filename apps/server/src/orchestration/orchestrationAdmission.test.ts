import { Effect, Queue } from "effect";
import { describe, expect, it } from "vitest";

import { tryAdmitOrchestrationCommand } from "./orchestrationAdmission.ts";

describe("orchestration command admission", () => {
  it("keeps reserved lifecycle capacity available under normal-command overload", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<string>(4);
        const policy = { capacity: 4, reservedCapacity: 1 } as const;
        const admit = (envelope: string, commandType: Parameters<
          typeof tryAdmitOrchestrationCommand<string>
        >[0]["commandType"]) =>
          tryAdmitOrchestrationCommand({ queue, envelope, commandType, policy });

        expect(admit("normal-1", "project.create")).toEqual({ accepted: true });
        expect(admit("normal-2", "project.create")).toEqual({ accepted: true });
        expect(admit("normal-3", "project.create")).toEqual({ accepted: true });
        expect(admit("normal-overload", "project.create")).toEqual({
          accepted: false,
          reason: "overloaded",
        });

        expect(admit("control", "thread.turn.interrupt")).toEqual({ accepted: true });
        expect(admit("control-overload", "thread.session.stop")).toEqual({
          accepted: false,
          reason: "overloaded",
        });

        yield* Queue.shutdown(queue);
        expect(admit("after-stop", "thread.turn.interrupt")).toEqual({
          accepted: false,
          reason: "stopped",
        });
      }),
    );
  });
});
