/**
 * CloudflareRuntimeProviderAdapterLive - the Cloudflare execution-runtime adapter.
 *
 * Built entirely on `CloudflareBridgeClient`, it provisions a bridge instance,
 * creates an interactive terminal transport (the same `JsonRpcLineTransport`
 * Codex consumes, fed by the bridge's terminal WebSocket), runs fire-and-collect
 * commands for the runtime-neutral git workspace, probes liveness for the
 * reconciler, and destroys instances. It owns no orchestration or persistence
 * concern — lifecycle recording is `ExecutionRuntimeService`'s job — so it stays
 * a pure provider boundary, matching `FakeRuntimeProviderAdapter`.
 *
 * @module CloudflareRuntimeProviderAdapterLive
 */
import { ExecutionInstanceId, type RuntimeInstanceSummary } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import type { JsonRpcLineTransport } from "../../provider/process/JsonRpcLineTransport.ts";
import { CloudflareBridgeError } from "../Errors.ts";
import { CloudflareBridgeClient } from "../Services/CloudflareBridgeClient.ts";
import { CloudflareRuntimeProviderAdapter } from "../Services/CloudflareRuntimeProviderAdapter.ts";
import type { RuntimeProcessSpawnInput } from "../Services/RuntimeProcessTransport.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "./cloudflareDescriptor.ts";

export interface CloudflareProvisionInput {
  readonly threadId: string;
  /** Ports to expose; persistent workspaces expose on demand, so usually empty. */
  readonly ports?: ReadonlyArray<number>;
  readonly idleTimeoutSeconds?: number;
}

export interface CloudflareInstanceContext {
  readonly instance: RuntimeInstanceSummary;
  readonly rootPath: string;
}

export interface CloudflareExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export interface CloudflareExecInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

export interface CloudflareRuntimeProviderAdapterShape {
  readonly descriptor: typeof CLOUDFLARE_RUNTIME_DESCRIPTOR;
  /** Provision a Cloudflare workspace instance through the bridge. */
  readonly provision: (
    input: CloudflareProvisionInput,
  ) => Effect.Effect<CloudflareInstanceContext, CloudflareBridgeError>;
  /**
   * Open the interactive terminal transport for a process inside the instance.
   * The bridge's terminal WebSocket is forwarded into the in-memory transport, so
   * the consumer (a provider session) sees the same `JsonRpcLineTransport` value
   * the local path produces.
   */
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    spawn: RuntimeProcessSpawnInput,
  ) => Effect.Effect<JsonRpcLineTransport, CloudflareBridgeError>;
  /** Fire-and-collect command exec the runtime-neutral git workspace rides on. */
  readonly execCollect: (
    instanceId: ExecutionInstanceId,
    input: CloudflareExecInput,
  ) => Effect.Effect<CloudflareExecResult, CloudflareBridgeError>;
  /**
   * Provider-agnostic liveness probe for the reconciler: a `getInstance` that
   * succeeds means the bridge still knows the instance. A 404 (surfaced as a
   * bridge error with status 404) means it is gone.
   */
  readonly isAlive: (instanceId: ExecutionInstanceId) => Effect.Effect<boolean>;
  /** Destroy the instance through the bridge. Idempotent. */
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
}

const filterEnv = (env: Record<string, string | undefined> | undefined): Record<string, string> => {
  if (env === undefined) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

const makeCloudflareRuntimeProviderAdapter = Effect.gen(function* () {
  const bridge = yield* CloudflareBridgeClient;

  const provision: CloudflareRuntimeProviderAdapterShape["provision"] = (input) =>
    bridge
      .createInstance({
        flavor: "workspace",
        ports: input.ports ?? [],
        env: {},
        ...(input.idleTimeoutSeconds === undefined
          ? {}
          : { idleTimeoutSeconds: input.idleTimeoutSeconds }),
      })
      .pipe(
        Effect.map((created) => {
          const rootPath = created.rootPath ?? "/workspace";
          const instance: RuntimeInstanceSummary = {
            id: created.id,
            provider: "cloudflare",
            status: created.status,
            rootPath,
            failureReason: created.failureReason ?? null,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
          };
          return { instance, rootPath } satisfies CloudflareInstanceContext;
        }),
      );

  const createTransport: CloudflareRuntimeProviderAdapterShape["createTransport"] = (
    instanceId,
    spawn,
  ) =>
    bridge.openTerminal({
      instanceId,
      command: spawn.command.trim().length === 0 ? null : spawn.command,
      args: spawn.args,
      cols: 80,
      rows: 24,
      cwd: spawn.cwd.length === 0 ? null : spawn.cwd,
    });

  const execCollect: CloudflareRuntimeProviderAdapterShape["execCollect"] = (instanceId, input) =>
    bridge
      .exec(instanceId, {
        role: "exec",
        command: input.command,
        args: input.args,
        cwd: input.cwd ?? null,
        env: filterEnv(input.env),
      })
      .pipe(
        Effect.map((result) => ({
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.exitCode,
        })),
      );

  const isAlive: CloudflareRuntimeProviderAdapterShape["isAlive"] = (instanceId) =>
    bridge.getInstance(instanceId).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    );

  const destroy: CloudflareRuntimeProviderAdapterShape["destroy"] = (instanceId) =>
    bridge.deleteInstance(instanceId).pipe(Effect.ignore);

  return {
    descriptor: CLOUDFLARE_RUNTIME_DESCRIPTOR,
    provision,
    createTransport,
    execCollect,
    isAlive,
    destroy,
  } satisfies CloudflareRuntimeProviderAdapterShape;
});

export const CloudflareRuntimeProviderAdapterLive = Layer.effect(
  CloudflareRuntimeProviderAdapter,
  makeCloudflareRuntimeProviderAdapter,
);
