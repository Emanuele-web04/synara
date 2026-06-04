import { RuntimePlan } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { RuntimePlanRejectedError } from "../Errors.ts";
import { ExecutionRuntimePlanner } from "../Services/ExecutionRuntimePlanner.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "./cloudflareDescriptor.ts";
import { ExecutionRuntimePlannerLive } from "./ExecutionRuntimePlanner.ts";
import { makeRuntimeProviderRegistryLive } from "./RuntimeProviderRegistry.ts";

const decodePlan = Schema.decodeUnknownSync(RuntimePlan);

const cloudflarePlan = (overrides: Record<string, unknown> = {}) =>
  decodePlan({ targetKind: "remote-runtime", provider: "cloudflare", ...overrides });

const layer = it.layer(
  Layer.provide(
    ExecutionRuntimePlannerLive,
    makeRuntimeProviderRegistryLive({ descriptors: [CLOUDFLARE_RUNTIME_DESCRIPTOR] }),
  ),
);

layer("cloudflareDescriptor planner validation", (it) => {
  it.effect("validates a remote-runtime agent plan with on-demand ports", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const plan = cloudflarePlan({ ports: [3000] });
      const validated = yield* planner.validate(plan, "agent");
      assert.deepEqual(validated, plan);
    }),
  );

  it.effect("hosts the terminal role (interactive PTY)", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const validated = yield* planner.validate(cloudflarePlan(), "terminal");
      assert.equal(validated.provider, "cloudflare");
    }),
  );

  it.effect("rejects a persistent plan (workspace filesystem is ephemeral)", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const result = yield* planner
        .validate(cloudflarePlan({ persistent: true }), "agent")
        .pipe(Effect.flip);
      assert.equal(result._tag, "RuntimePlanRejectedError");
      assert.isTrue(
        (result as RuntimePlanRejectedError).reasons.some((reason) =>
          reason.includes("persistent"),
        ),
      );
    }),
  );

  it.effect("rejects a snapshot the provider cannot honor", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const result = yield* planner
        .validate(cloudflarePlan({ snapshotId: "snap-1" }), "agent")
        .pipe(Effect.flip);
      assert.equal(result._tag, "RuntimePlanRejectedError");
      assert.isTrue(
        (result as RuntimePlanRejectedError).reasons.some((reason) => reason.includes("snapshots")),
      );
    }),
  );
});
