/**
 * ModalCommandTransport - Server-internal boundary the Modal adapter runs
 * commands through, regardless of whether a real Modal account backs it.
 *
 * Two operations, mirroring the runtime-neutral primitives the rest of the
 * execution-runtime infra already speaks:
 *
 * - `execCollect` — fire-and-collect a command inside an instance, returning its
 *   full stdout/stderr/exit. This is the primitive `RuntimeGitWorkspace`-style
 *   verification work rides on (remote `bun typecheck`/`lint`/`test`/`build`).
 *   Modal exposes no stable per-exec process id, so this never claims one.
 * - `createTransport` — line-frame a long-lived process's output into the same
 *   in-memory `JsonRpcLineTransport` Codex consumes. Modal's log stream is the
 *   process output; there is no separate PTY channel, so a non-job role plugs in
 *   exactly like every other non-PTY remote.
 *
 * The transport never records orchestration events or touches persistence: that
 * is the `ExecutionRuntimeService`'s job. It is a pure provider boundary. The
 * concrete backend (real Modal SDK vs. a local fake) is chosen at layer build
 * time by {@link makeModalCommandClientLive} from credential presence.
 *
 * @module ModalCommandTransport
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { ExecutionInstanceId } from "@t3tools/contracts";

import type {
  InMemoryTransportController,
  JsonRpcLineTransport,
} from "../../../provider/process/JsonRpcLineTransport.ts";
import type { ModalRuntimeRole } from "./ModalRuntimeRole.ts";

/** Resolved facts about a provisioned Modal instance. */
export interface ModalInstanceContext {
  readonly instanceId: ExecutionInstanceId;
  /** Working root inside the instance (a temp dir for the fake backend). */
  readonly rootPath: string;
  readonly role: ModalRuntimeRole;
}

export interface ModalProvisionInput {
  readonly threadId: string;
  readonly role: ModalRuntimeRole;
}

export interface ModalExecInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Resolved relative to the instance root; defaults to the root. */
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

/** Collected output of a fire-and-collect command run inside an instance. */
export interface ModalExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export interface ModalProcessSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

/** An exposed tunnel / web endpoint on a Modal service or preview instance. */
export interface ModalExposedRoute {
  readonly port: number;
  readonly url: string | null;
}

export interface ModalCommandTransportShape {
  /** Whether a real Modal account backs this transport (vs. the local fake). */
  readonly backendKind: "real" | "fake";
  /** Provision (or resolve) the instance backing a thread. */
  readonly provision: (input: ModalProvisionInput) => Effect.Effect<ModalInstanceContext>;
  /**
   * Fire-and-collect a command inside an instance. The verification-job
   * primitive: collects full output rather than line-framing it.
   */
  readonly execCollect: (
    instanceId: ExecutionInstanceId,
    input: ModalExecInput,
  ) => Effect.Effect<ModalExecResult, never, ChildProcessSpawner.ChildProcessSpawner>;
  /**
   * Line-frame a long-lived process's output into the in-memory transport. When
   * the spawn input names a runnable command the backend forwards it; otherwise
   * a bare scriptable transport is returned (a test drives its controller).
   */
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    spawn: ModalProcessSpawnInput,
  ) => Effect.Effect<
    {
      readonly transport: JsonRpcLineTransport;
      readonly controller: InMemoryTransportController;
    },
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  /**
   * Expose a port as a tunnel / web endpoint. Fails-soft (returns a null url) for
   * roles/backends without ingress; the planner already rejects port requests a
   * role's descriptor cannot honor, so reaching here means ingress is allowed.
   */
  readonly exposePort: (
    instanceId: ExecutionInstanceId,
    port: number,
  ) => Effect.Effect<ModalExposedRoute>;
  /**
   * Whether the backend still recognizes a provisioned instance. The reconciler
   * uses this as the provider-agnostic liveness probe.
   */
  readonly isAlive: (instanceId: ExecutionInstanceId) => Effect.Effect<boolean>;
  /** Tear the instance down and forget it. Idempotent. */
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
}

export class ModalCommandTransport extends ServiceMap.Service<
  ModalCommandTransport,
  ModalCommandTransportShape
>()("t3/executionRuntime/providers/modal/ModalCommandTransport") {}
