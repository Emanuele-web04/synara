/**
 * describeRuntimeProviderContract - the Phase-17 baseline provider contract.
 *
 * A reusable vitest suite every execution-runtime provider must pass. It asserts
 * the provider-neutral behavior the orchestration seam depends on, against a
 * thin {@link RuntimeProviderUnderTest} the caller wires to a concrete adapter:
 *
 *   - the descriptor's declared capabilities are internally consistent (honest);
 *   - the planner rejects an unsupported plan/role *before* anything is created;
 *   - provision creates an instance and reports it alive;
 *   - fire-and-collect exec runs a real command and returns stdout + exit code;
 *   - a non-zero command surfaces its exit code rather than throwing;
 *   - a process transport streams JSON-RPC frames both ways and signals exit;
 *   - git clone + diff collect a diff over the exec channel;
 *   - destroy is idempotent and drops the instance from the provider's view.
 *
 * Fakes run this in CI; a real provider opts in via its own env gate. The harness
 * spawns real local processes and runs real git, so passing it against the fake
 * client is a meaningful baseline, not a mock check.
 *
 * @module providers/contract/describeRuntimeProviderContract
 */
import { existsSync } from "node:fs";
import nodePath from "node:path";

import type { ExecutionInstanceId, RuntimeRole } from "@t3tools/contracts";
import { Deferred, Effect, Stream, type ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "../../../processRunner.ts";
import type {
  InMemoryTransportController,
  JsonRpcLineTransport,
} from "../../../provider/process/JsonRpcLineTransport.ts";
import type { RuntimeProviderDescriptor } from "../../Services/RuntimeProviderDescriptor.ts";

/** A provisioned instance plus the root the harness reads/writes under. */
export interface ContractInstance {
  readonly instanceId: ExecutionInstanceId;
  readonly rootPath: string;
}

export interface ContractExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export interface ContractTransport {
  readonly transport: JsonRpcLineTransport;
  /**
   * Optional: providers whose transport forwards a real channel (e.g.
   * Cloudflare's terminal WebSocket) return a bare transport with no in-memory
   * controller. The harness body only drives the transport, never the
   * controller, so the carve-out matches the production shape's optional field.
   */
  readonly controller?: InMemoryTransportController;
}

/**
 * The minimal provider surface the contract exercises. A caller adapts its
 * concrete adapter to these operations and supplies a {@link ManagedRuntime}
 * carrying the provider's dependencies. Each operation runs against that runtime.
 */
export interface RuntimeProviderUnderTest<R> {
  readonly descriptor: RuntimeProviderDescriptor;
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  readonly provision: (threadId: string) => Effect.Effect<ContractInstance, unknown, R>;
  readonly exec: (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ContractExecResult, unknown, R>;
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ContractTransport, unknown, R>;
  readonly isAlive: (instanceId: ExecutionInstanceId) => Effect.Effect<boolean, unknown, R>;
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void, unknown, R>;
  /**
   * Validate a remote agent plan against the descriptor for the given role.
   * Resolves for a supported role, fails for an unsupported one — proving
   * rejection happens before any provisioning. Wired to `ExecutionRuntimePlanner`.
   */
  readonly validatePlanForRole: (role: RuntimeRole) => Effect.Effect<unknown, unknown, R>;
}

/** Assert a descriptor's capabilities do not contradict each other. */
const assertDescriptorHonest = (descriptor: RuntimeProviderDescriptor): void => {
  const caps = descriptor.capabilities;
  expect(caps.exec.pty || caps.exec.command).toBe(true);
  expect(caps.exec.roles.length).toBeGreaterThan(0);
  if (!caps.ingress.exposePort) {
    expect(caps.ingress.declarePortsAtCreate).toBe(false);
    expect(caps.ingress.maxRoutes === 0 || caps.ingress.maxRoutes === null).toBe(true);
  }
  if (caps.lease.renewable) {
    expect(caps.lease.required).toBe(true);
  }
  if (caps.persistence.snapshots) {
    expect(caps.lifecycle.snapshot).toBe(true);
  }
};

/** Seed a bare git remote with one commit, standing in for a private repo. */
const makeBareRemote = async (): Promise<string> => {
  const base = await runProcess("mktemp", ["-d", "-t", "synara-contract-git"]);
  const root = base.stdout.trim();
  const remote = nodePath.join(root, "remote.git");
  const seed = nodePath.join(root, "seed");
  await runProcess("git", ["init", "--bare", remote]);
  await runProcess("git", ["init", seed]);
  await runProcess("git", ["-C", seed, "config", "user.email", "t@example.com"]);
  await runProcess("git", ["-C", seed, "config", "user.name", "Test"]);
  await runProcess("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
  await runProcess("bash", ["-c", `printf 'hello\\n' > ${nodePath.join(seed, "README.md")}`]);
  await runProcess("git", ["-C", seed, "add", "."]);
  await runProcess("git", ["-C", seed, "commit", "-m", "init"]);
  await runProcess("git", ["-C", seed, "branch", "-M", "main"]);
  await runProcess("git", ["-C", seed, "remote", "add", "origin", remote]);
  await runProcess("git", ["-C", seed, "push", "origin", "main"]);
  return remote;
};

export const describeRuntimeProviderContract = <R>(
  providerName: string,
  makeProvider: () => RuntimeProviderUnderTest<R>,
): void => {
  describe(`runtime provider contract: ${providerName}`, () => {
    let provider: RuntimeProviderUnderTest<R> | undefined;

    afterEach(async () => {
      if (provider) {
        await provider.runtime.dispose();
        provider = undefined;
      }
    });

    it("declares honest, internally-consistent capabilities", () => {
      provider = makeProvider();
      assertDescriptorHonest(provider.descriptor);
    });

    it("accepts a supported plan and rejects an unsupported role pre-create", async () => {
      provider = makeProvider();
      const localProvider = provider;
      const hostable = localProvider.descriptor.capabilities.exec.roles[0] ?? "agent";
      await localProvider.runtime.runPromise(localProvider.validatePlanForRole(hostable));

      const unsupported = (["agent", "setup", "git", "exec", "terminal"] as const).find(
        (role) => !localProvider.descriptor.capabilities.exec.roles.includes(role),
      );
      if (unsupported !== undefined) {
        const exit = await localProvider.runtime.runPromiseExit(
          localProvider.validatePlanForRole(unsupported),
        );
        expect(exit._tag).toBe("Failure");
      }
    });

    it("provisions an instance and reports it alive", async () => {
      provider = makeProvider();
      const localProvider = provider;
      const instance = await localProvider.runtime.runPromise(
        localProvider.provision("contract-provision"),
      );
      expect(instance.instanceId).toBeTruthy();
      expect(
        await localProvider.runtime.runPromise(localProvider.isAlive(instance.instanceId)),
      ).toBe(true);
    });

    it("executes a command and collects stdout + a zero exit code", async () => {
      provider = makeProvider();
      const localProvider = provider;
      const instance = await localProvider.runtime.runPromise(
        localProvider.provision("contract-exec"),
      );
      const result = await localProvider.runtime.runPromise(
        localProvider.exec(instance.instanceId, "printf", ["hello-contract"]),
      );
      expect(result.stdout).toContain("hello-contract");
      expect(result.code).toBe(0);
    });

    it("surfaces a non-zero exit code instead of throwing", async () => {
      provider = makeProvider();
      const localProvider = provider;
      const instance = await localProvider.runtime.runPromise(
        localProvider.provision("contract-failure"),
      );
      const result = await localProvider.runtime.runPromise(
        localProvider.exec(instance.instanceId, "sh", ["-c", "exit 3"]),
      );
      expect(result.code).toBe(3);
    });

    it("streams JSON-RPC frames and signals process exit over the transport", async () => {
      provider = makeProvider();
      const localProvider = provider;
      const instance = await localProvider.runtime.runPromise(
        localProvider.provision("contract-transport"),
      );

      // A tiny echo agent: read one line from stdin, echo it on stdout, exit.
      // Proves outbound frame -> remote stdin -> remote stdout -> inbound, plus a
      // real process-exit signal surfacing on the transport's exit deferred.
      const script =
        "const l=require('readline').createInterface({input:process.stdin});" +
        "l.on('line',(s)=>{process.stdout.write(s+'\\n');process.exit(0);});";
      const built = await localProvider.runtime.runPromise(
        localProvider.createTransport(instance.instanceId, process.execPath, ["-e", script]),
      );

      const inbound = await localProvider.runtime.runPromise(
        Effect.gen(function* () {
          yield* built.transport.send({ method: "ping", id: "1" });
          return yield* built.transport.inbound.pipe(
            Stream.runHead,
            Effect.timeout("8 seconds"),
            Effect.map((option) => (option._tag === "Some" ? option.value : "")),
            Effect.orElseSucceed(() => ""),
          );
        }),
      );
      expect(inbound).toContain("ping");

      const exited = await localProvider.runtime.runPromise(
        Deferred.await(built.transport.exit).pipe(
          Effect.timeout("8 seconds"),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      );
      expect(exited).toBe(true);

      await localProvider.runtime.runPromise(built.transport.close);
    });

    it("clones a repo and collects a diff over the exec channel", async () => {
      provider = makeProvider();
      const localProvider = provider;
      if (!localProvider.descriptor.capabilities.git.clone) {
        return;
      }
      const remote = await makeBareRemote();
      const instance = await localProvider.runtime.runPromise(
        localProvider.provision("contract-git"),
      );

      await localProvider.runtime.runPromise(
        localProvider.exec(instance.instanceId, "git", ["clone", remote, "checkout"]),
      );
      const checkout = nodePath.join(instance.rootPath, "checkout");
      expect(existsSync(nodePath.join(checkout, "README.md"))).toBe(true);

      await runProcess("bash", [
        "-c",
        `printf 'changed\\n' >> ${nodePath.join(checkout, "README.md")}`,
      ]);
      const diff = await localProvider.runtime.runPromise(
        localProvider.exec(instance.instanceId, "git", ["-C", "checkout", "diff", "HEAD"]),
      );
      expect(diff.stdout).toContain("README.md");
      expect(diff.stdout).toContain("changed");
    });

    it("destroys idempotently and drops the instance from the provider's view", async () => {
      provider = makeProvider();
      const localProvider = provider;
      const instance = await localProvider.runtime.runPromise(
        localProvider.provision("contract-destroy"),
      );
      await localProvider.runtime.runPromise(localProvider.destroy(instance.instanceId));
      expect(
        await localProvider.runtime.runPromise(localProvider.isAlive(instance.instanceId)),
      ).toBe(false);
      // Destroying again is a no-op, not an error.
      await localProvider.runtime.runPromise(localProvider.destroy(instance.instanceId));
    });
  });
};
