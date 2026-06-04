import { existsSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionInstanceId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ExecutionRuntimePlannerLive } from "../../Layers/ExecutionRuntimePlanner.ts";
import { makeRuntimeProviderRegistryLive } from "../../Layers/RuntimeProviderRegistry.ts";
import { ExecutionRuntimePlanner } from "../../Services/ExecutionRuntimePlanner.ts";
import { RuntimeProviderRegistry } from "../../Services/RuntimeProviderRegistry.ts";
import { ModalCommandClientFakeLive } from "./ModalCommandClient.ts";
import { resolveModalCredentials } from "./ModalCredentials.ts";
import { MODAL_PROVIDER_DESCRIPTOR, modalDescriptorForRole } from "./modalDescriptors.ts";
import { MODAL_RUNTIME_ROLES } from "./ModalRuntimeRole.ts";
import {
  ModalRuntimeProviderAdapter,
  ModalRuntimeProviderAdapterLive,
} from "./ModalRuntimeProviderAdapter.ts";

const makeTestRuntime = () => {
  const layer = ModalRuntimeProviderAdapterLive.pipe(
    Layer.provide(ModalCommandClientFakeLive),
    Layer.provideMerge(NodeServices.layer),
  );
  return ManagedRuntime.make(layer);
};

type TestRuntime = ReturnType<typeof makeTestRuntime>;

const provisionInstance = (runtime: TestRuntime, role: "job" | "service" | "preview") =>
  runtime.runPromise(
    Effect.gen(function* () {
      const adapter = yield* ModalRuntimeProviderAdapter;
      return yield* adapter.provision({ threadId: "thread-modal", role });
    }),
  );

describe("Modal runtime descriptors", () => {
  it("never claims a PTY for any role", () => {
    for (const role of MODAL_RUNTIME_ROLES) {
      const descriptor = modalDescriptorForRole(role);
      expect(descriptor.provider).toBe("modal");
      expect(descriptor.capabilities.exec.pty).toBe(false);
      expect(descriptor.capabilities.exec.command).toBe(true);
      expect(descriptor.targetKinds).toEqual(["remote-runtime"]);
    }
  });

  it("treats a job's logs as process output with a terminal Finished state", () => {
    const job = modalDescriptorForRole("job");
    // A finished job cannot be re-attached; no ingress, no PTY, no snapshots.
    expect(job.capabilities.lifecycle.reconnect).toBe(false);
    expect(job.capabilities.ingress.exposePort).toBe(false);
    expect(job.capabilities.persistence.snapshots).toBe(false);
  });

  it("tracks volume sync separately from snapshots", () => {
    for (const role of MODAL_RUNTIME_ROLES) {
      const descriptor = modalDescriptorForRole(role);
      expect(descriptor.capabilities.persistence.snapshots).toBe(false);
      expect(descriptor.capabilities.persistence.volumes).toBe(true);
    }
  });

  it("exposes ingress only for service and preview roles", () => {
    expect(modalDescriptorForRole("job").capabilities.ingress.exposePort).toBe(false);
    expect(modalDescriptorForRole("service").capabilities.ingress.exposePort).toBe(true);
    expect(modalDescriptorForRole("preview").capabilities.ingress.exposePort).toBe(true);
  });
});

describe("ModalCredentials", () => {
  it("falls back to the fake backend when either token is absent", () => {
    expect(resolveModalCredentials({})).toBeNull();
    expect(resolveModalCredentials({ MODAL_TOKEN_ID: "id" })).toBeNull();
    expect(resolveModalCredentials({ MODAL_TOKEN_SECRET: "secret" })).toBeNull();
    expect(
      resolveModalCredentials({ MODAL_TOKEN_ID: "  ", MODAL_TOKEN_SECRET: "secret" }),
    ).toBeNull();
  });

  it("resolves real credentials when both tokens are present", () => {
    const resolved = resolveModalCredentials({
      MODAL_TOKEN_ID: "id-123",
      MODAL_TOKEN_SECRET: "secret-456",
      MODAL_ENVIRONMENT: "prod",
    });
    expect(resolved).toEqual({ tokenId: "id-123", tokenSecret: "secret-456", environment: "prod" });
  });
});

describe("Modal runtime provider adapter (fake backend, no credentials)", () => {
  let runtime: TestRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("uses the fake backend when no Modal credentials are configured", async () => {
    runtime = makeTestRuntime();
    const backendKind = await runtime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        return adapter.backendKind;
      }),
    );
    expect(backendKind).toBe("fake");
  });

  it("runs a verification job, streams its logs back, and reports a terminal exit", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;
    const context = await provisionInstance(localRuntime, "job");
    expect(context.instance.provider).toBe("modal");
    expect(existsSync(context.rootPath)).toBe(true);

    // A passing verification command: logs on stdout, exit 0 (Finished/clean).
    const ok = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        return yield* adapter.execCollect(context.instance.id, {
          command: "node",
          args: ["-e", "console.log('typecheck passed'); process.exit(0)"],
        });
      }),
    );
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("typecheck passed");

    // A failing verification command: a non-zero exit is a terminal job result,
    // not a provider fault — execCollect succeeds with the failure captured.
    const failed = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        return yield* adapter.execCollect(context.instance.id, {
          command: "node",
          args: ["-e", "console.error('lint failed'); process.exit(2)"],
        });
      }),
    );
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain("lint failed");

    // Terminate and collect: destroy removes the staging dir; isAlive flips false.
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        yield* adapter.destroy(context.instance.id);
      }),
    );
    expect(existsSync(context.rootPath)).toBe(false);
    const aliveAfterDestroy = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        return yield* adapter.isAlive(context.instance.id);
      }),
    );
    expect(aliveAfterDestroy).toBe(false);
  });

  it("forwards a service process's output through the in-memory transport", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;
    const context = await provisionInstance(localRuntime, "service");

    const handle = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        return yield* adapter.createTransport(context.instance.id, {
          command: "printf",
          args: ['{"ready":true}\n'],
          cwd: context.rootPath,
          env: {},
        });
      }),
    );

    const firstLine = await localRuntime.runPromise(
      Stream.runHead(handle.transport.inbound).pipe(
        Effect.map((option) => (option._tag === "Some" ? option.value : "")),
      ),
    );
    expect(firstLine).toContain("ready");

    await localRuntime.runPromise(handle.transport.close).catch(() => {});
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        yield* adapter.destroy(context.instance.id);
      }),
    );
  });

  it("returns a bare scriptable transport when no command is supplied", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;
    const context = await provisionInstance(localRuntime, "service");

    const line = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        const handle = yield* adapter.createTransport(context.instance.id, {
          command: "",
          args: [],
          cwd: context.rootPath,
          env: {},
        });
        yield* handle.controller.pushInbound('{"scripted":true}');
        const head = yield* Stream.runHead(handle.transport.inbound);
        yield* handle.transport.close;
        return head._tag === "Some" ? head.value : "";
      }),
    );
    expect(line).toContain("scripted");

    await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        yield* adapter.destroy(context.instance.id);
      }),
    );
  });

  it("exposes a tunnel route for a service instance", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;
    const context = await provisionInstance(localRuntime, "preview");

    const route = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        return yield* adapter.exposePort(context.instance.id, 3000);
      }),
    );
    expect(route.port).toBe(3000);
    expect(route.url).not.toBeNull();

    await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        yield* adapter.destroy(context.instance.id);
      }),
    );
  });

  it("reports a non-zero exit for a command against an unknown instance", async () => {
    runtime = makeTestRuntime();
    const localRuntime = runtime;
    const result = await localRuntime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ModalRuntimeProviderAdapter;
        return yield* adapter.execCollect(ExecutionInstanceId.makeUnsafe("modal-missing"), {
          command: "node",
          args: ["-e", "process.exit(0)"],
        });
      }),
    );
    expect(result.code).toBe(127);
  });
});

describe("Modal plan validation via the shared planner", () => {
  const registryLayer = makeRuntimeProviderRegistryLive({
    descriptors: [MODAL_PROVIDER_DESCRIPTOR],
  });
  const layer = ExecutionRuntimePlannerLive.pipe(Layer.provide(registryLayer));
  const runtime = ManagedRuntime.make(Layer.mergeAll(layer, registryLayer));

  it("resolves the modal descriptor by provider", async () => {
    const descriptor = await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        return yield* registry.getDescriptor("modal");
      }),
    );
    expect(descriptor.provider).toBe("modal");
    expect(descriptor.capabilities.exec.pty).toBe(false);
  });

  it("rejects a port request against the job descriptor before any provisioning", async () => {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const planner = yield* ExecutionRuntimePlanner;
        return yield* planner.validateAgainstDescriptor(
          {
            targetKind: "remote-runtime",
            provider: "modal",
            ports: [3000],
            persistent: false,
            snapshotId: null,
          },
          "agent",
          modalDescriptorForRole("job"),
        );
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const error = exit.cause;
      const rendered = JSON.stringify(error);
      expect(rendered).toContain("RuntimePlanRejected");
    }
  });

  it("accepts a tunnel request against the service descriptor", async () => {
    const plan = await runtime.runPromise(
      Effect.gen(function* () {
        const planner = yield* ExecutionRuntimePlanner;
        return yield* planner.validateAgainstDescriptor(
          {
            targetKind: "remote-runtime",
            provider: "modal",
            ports: [3000],
            persistent: false,
            snapshotId: null,
          },
          "agent",
          modalDescriptorForRole("service"),
        );
      }),
    );
    expect(plan.ports).toEqual([3000]);
  });

  it("rejects the interactive terminal role on a job: Modal has no PTY", async () => {
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const planner = yield* ExecutionRuntimePlanner;
        return yield* planner.validateAgainstDescriptor(
          {
            targetKind: "remote-runtime",
            provider: "modal",
            ports: [],
            persistent: false,
            snapshotId: null,
          },
          "terminal",
          modalDescriptorForRole("job"),
        );
      }),
    );
    // A job cannot host the interactive terminal role (no PTY); rejected.
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("terminal");
    }
  });
});
