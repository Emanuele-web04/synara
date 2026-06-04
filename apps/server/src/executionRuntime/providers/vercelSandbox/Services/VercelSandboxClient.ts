/**
 * VercelSandboxClient - the thin provider boundary the Vercel Sandbox adapter
 * talks to.
 *
 * This is the only place that knows the shape of the Vercel Sandbox API. The
 * adapter is written against this interface so it can run unchanged against
 * either the real client (gated behind env credentials) or the in-memory fake
 * used by the contract tests when no credentials are present. Vercel Sandbox is
 * command/log/file/preview-first: there is no PTY and no host pid, ports are
 * declared at create time, and the filesystem is ephemeral unless snapshotted.
 *
 * Every operation here is provider-native (a sandbox id, a command stream, a
 * file path inside the sandbox). The adapter maps these onto the runtime-neutral
 * `RuntimeInstanceSummary` / `JsonRpcLineTransport` / git-exec contracts the rest
 * of the system consumes; this interface stays Vercel-shaped.
 *
 * @module VercelSandboxClient
 */
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { RuntimeRemoteOperationFailedError } from "../../../Errors.ts";

/** Opaque sandbox id minted by the provider at create time. */
export type VercelSandboxId = string;

/** A port declared at create time, paired with the public URL it resolves to. */
export interface VercelSandboxPort {
  readonly port: number;
  /** Public preview URL, or null until the sandbox has finished routing it. */
  readonly url: string | null;
}

export interface VercelSandboxCreateInput {
  /**
   * Ports to expose. Vercel Sandbox requires these at create time, so the
   * adapter forwards the plan's declared ports here — they cannot be added on
   * demand later.
   */
  readonly ports: ReadonlyArray<number>;
  /** Initial wall-clock timeout in seconds; activity extends it via {@link extendTimeout}. */
  readonly timeoutSeconds: number;
  /** Snapshot to restore from, or null for a fresh sandbox. */
  readonly snapshotId: string | null;
  readonly resources?: {
    readonly cpu?: number | undefined;
    readonly memoryMb?: number | undefined;
  };
}

export interface VercelSandboxCreated {
  readonly sandboxId: VercelSandboxId;
  /** Absolute working directory root inside the sandbox. */
  readonly rootPath: string;
  /** Declared ports with their resolved preview URLs. */
  readonly ports: ReadonlyArray<VercelSandboxPort>;
}

export interface VercelSandboxCommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Path relative to the sandbox root; defaults to the root when omitted. */
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  /**
   * Detached commands return immediately and stream their logs; the agent
   * process runs detached so the adapter can forward its stdout/stderr as logs
   * to a JSON-RPC transport. A non-detached command is fire-and-collect.
   */
  readonly detached: boolean;
}

/** A streaming command handle: logs as they arrive, plus the eventual exit. */
export interface VercelSandboxCommandHandle {
  /** Line-framed stdout lines as they stream from the sandbox. */
  readonly stdout: Stream.Stream<string>;
  /** Line-framed stderr/log lines (Vercel surfaces stderr as logs). */
  readonly stderr: Stream.Stream<string>;
  /**
   * Write a line to the running command's stdin (used to forward JSON-RPC
   * frames to a detached agent process). No-op for commands without stdin.
   */
  readonly writeStdin: (line: string) => Effect.Effect<void>;
  /** Resolves once with the command's exit code (null if killed/timed out). */
  readonly exitCode: Effect.Effect<number | null>;
  /** Kill the running command. Idempotent. */
  readonly kill: Effect.Effect<void>;
}

/** Collected result of a fire-and-collect command. */
export interface VercelSandboxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface VercelSandboxClientShape {
  /** Create a sandbox with its ports declared up front. */
  readonly create: (
    input: VercelSandboxCreateInput,
  ) => Effect.Effect<VercelSandboxCreated, RuntimeRemoteOperationFailedError>;
  /** Start a streaming/detached command inside a sandbox. */
  readonly runCommandStreaming: (
    sandboxId: VercelSandboxId,
    input: VercelSandboxCommandInput,
  ) => Effect.Effect<VercelSandboxCommandHandle, RuntimeRemoteOperationFailedError>;
  /** Run a command and collect its full output (the git-exec primitive). */
  readonly runCommandCollect: (
    sandboxId: VercelSandboxId,
    input: VercelSandboxCommandInput,
  ) => Effect.Effect<VercelSandboxCommandResult, RuntimeRemoteOperationFailedError>;
  /** Write a file into the sandbox filesystem (seeding a checkout, config, ...). */
  readonly writeFile: (
    sandboxId: VercelSandboxId,
    path: string,
    contents: Uint8Array,
  ) => Effect.Effect<void, RuntimeRemoteOperationFailedError>;
  /** Read a file from the sandbox filesystem. */
  readonly readFile: (
    sandboxId: VercelSandboxId,
    path: string,
  ) => Effect.Effect<Uint8Array, RuntimeRemoteOperationFailedError>;
  /**
   * Resolve the public preview URL for a declared port. Fails if the port was
   * not declared at create time (Vercel cannot expose a port on demand).
   */
  readonly getPortUrl: (
    sandboxId: VercelSandboxId,
    port: number,
  ) => Effect.Effect<string, RuntimeRemoteOperationFailedError>;
  /** Take a snapshot of the sandbox filesystem; returns the snapshot id. */
  readonly snapshot: (
    sandboxId: VercelSandboxId,
  ) => Effect.Effect<string, RuntimeRemoteOperationFailedError>;
  /** Extend the sandbox's wall-clock timeout (the activity-lease keepalive). */
  readonly extendTimeout: (
    sandboxId: VercelSandboxId,
    additionalSeconds: number,
  ) => Effect.Effect<void, RuntimeRemoteOperationFailedError>;
  /** Whether the provider still reports the sandbox as live (reconciler probe). */
  readonly isAlive: (sandboxId: VercelSandboxId) => Effect.Effect<boolean>;
  /** Stop a running sandbox without destroying its filesystem. Idempotent. */
  readonly stop: (sandboxId: VercelSandboxId) => Effect.Effect<void>;
  /** Destroy a sandbox and free its resources. Idempotent. */
  readonly destroy: (sandboxId: VercelSandboxId) => Effect.Effect<void>;
}

export class VercelSandboxClient extends ServiceMap.Service<
  VercelSandboxClient,
  VercelSandboxClientShape
>()("t3/executionRuntime/providers/vercelSandbox/VercelSandboxClient") {}
