import { RuntimePlan, type ExecutionRuntimeProvider } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";

import { Effect, Layer, Schema } from "effect";

import { RuntimePlanRejectedError, RuntimeProviderUnsupportedError } from "../Errors.ts";
import { ExecutionRuntimePlanner } from "../Services/ExecutionRuntimePlanner.ts";
import type { RuntimeProviderDescriptor } from "../Services/RuntimeProviderDescriptor.ts";
import { ExecutionRuntimePlannerLive } from "./ExecutionRuntimePlanner.ts";
import {
  makeRuntimeProviderRegistryLive,
  RuntimeProviderRegistryLive,
} from "./RuntimeProviderRegistry.ts";

const decodePlan = Schema.decodeUnknownSync(RuntimePlan);

const planFor = (provider: ExecutionRuntimeProvider, overrides: Record<string, unknown> = {}) =>
  decodePlan({
    targetKind: provider === "worktree" ? "worktree" : "local",
    provider,
    ...overrides,
  });

const agentOnlyDescriptors: ReadonlyArray<RuntimeProviderDescriptor> = [
  {
    provider: "local",
    targetKinds: ["local"],
    capabilities: {
      lifecycle: { stop: true, snapshot: false, archive: false, reconnect: false },
      exec: { pty: false, command: true, roles: ["agent"] },
      fs: { persistent: true, writable: true },
      git: { clone: false, diff: true },
      ingress: { exposePort: false, declarePortsAtCreate: false, maxRoutes: 0 },
      persistence: { snapshots: false, volumes: false },
      network: { egress: true, outboundProxy: false },
      lease: { required: false, renewable: false },
      quirks: { noStderrChannel: false, noProcessId: false, ephemeralUnlessSnapshotted: false },
    },
  },
];

const layer = it.layer(Layer.provide(ExecutionRuntimePlannerLive, RuntimeProviderRegistryLive));

layer("ExecutionRuntimePlannerLive", (it) => {
  it.effect("accepts a supported local agent plan", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const plan = planFor("local");
      const validated = yield* planner.validate(plan, "agent");
      assert.deepEqual(validated, plan);
    }),
  );

  it.effect("accepts a supported worktree git plan", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const plan = planFor("worktree");
      const validated = yield* planner.validate(plan, "git");
      assert.deepEqual(validated, plan);
    }),
  );

  it.effect("rejects a target kind the provider does not back", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const plan = planFor("local", { targetKind: "remote-runtime" });
      const result = yield* planner.validate(plan, "agent").pipe(Effect.flip);
      assert.equal(result._tag, "RuntimePlanRejectedError");
      assert.isTrue(
        (result as RuntimePlanRejectedError).reasons.some((reason) =>
          reason.includes("target kind"),
        ),
      );
    }),
  );

  it.effect("rejects ports against a provider with no ingress", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const plan = planFor("local", { ports: [3000] });
      const result = yield* planner.validate(plan, "agent").pipe(Effect.flip);
      assert.equal(result._tag, "RuntimePlanRejectedError");
      assert.isTrue(
        (result as RuntimePlanRejectedError).reasons.some((reason) => reason.includes("ports")),
      );
    }),
  );

  it.effect("rejects snapshots local cannot honor", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const plan = planFor("local", { snapshotId: "snap-1" });
      const result = yield* planner.validate(plan, "agent").pipe(Effect.flip);
      assert.equal(result._tag, "RuntimePlanRejectedError");
      assert.isTrue(
        (result as RuntimePlanRejectedError).reasons.some((reason) => reason.includes("snapshots")),
      );
    }),
  );

  it.effect("fails for a provider with no registered descriptor", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const plan = planFor("daytona", { targetKind: "remote-runtime" });
      const result = yield* planner.validate(plan, "agent").pipe(Effect.flip);
      assert.equal(result._tag, "RuntimeProviderUnsupportedError");
      assert.equal((result as RuntimeProviderUnsupportedError).provider, "daytona");
    }),
  );
});

const agentOnlyLayer = it.layer(
  Layer.provide(
    ExecutionRuntimePlannerLive,
    makeRuntimeProviderRegistryLive({ descriptors: agentOnlyDescriptors }),
  ),
);

agentOnlyLayer("ExecutionRuntimePlannerLive (role validation)", (it) => {
  it.effect("rejects a role the provider cannot host", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const result = yield* planner.validate(planFor("local"), "git").pipe(Effect.flip);
      assert.equal(result._tag, "RuntimePlanRejectedError");
      assert.isTrue(
        (result as RuntimePlanRejectedError).reasons.some((reason) => reason.includes("role")),
      );
    }),
  );

  it.effect("accepts a role the provider can host", () =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      const plan = planFor("local");
      const validated = yield* planner.validate(plan, "agent");
      assert.deepEqual(validated, plan);
    }),
  );
});
