/**
 * DaytonaSandboxClient - the narrow Daytona sandbox boundary.
 *
 * This is the only surface that knows the Daytona wire shape. Two
 * implementations satisfy it:
 *
 *   - {@link FakeDaytonaSandboxClient} runs everything locally in per-sandbox
 *     temp dirs (no network), used by default and in the baseline contract suite
 *     when credentials are absent.
 *   - the HTTP client (`HttpDaytonaSandboxClient`) talks to the real Daytona REST
 *     API, gated behind `DAYTONA_API_KEY`.
 *
 * `DaytonaRuntimeAdapter` consumes this client and exposes the provider-neutral
 * adapter shape (`provision` / `createTransport` / `execCollect` / `isAlive` /
 * `destroy` / `stop` / `snapshot` / `refreshActivity`). Keeping the wire shape
 * behind this interface lets the adapter, the git workspace, and the contract
 * suite run identically against the fake and the real provider.
 *
 * @module daytona/DaytonaSandboxClient
 */
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProcessExit } from "../../../provider/process/JsonRpcLineTransport.ts";
import type { DaytonaApiError, DaytonaSandboxUnknownError } from "./DaytonaErrors.ts";

/** Provider-side liveness/lifecycle status of a sandbox, normalized. */
export type DaytonaSandboxStatus =
  | "starting"
  | "running"
  | "stopped"
  | "archived"
  | "destroyed"
  | "error"
  | "unknown";

export interface DaytonaSandbox {
  readonly id: string;
  readonly status: DaytonaSandboxStatus;
  /** Absolute working directory inside the sandbox the agent and git run in. */
  readonly rootPath: string;
}

export interface DaytonaCreateInput {
  /** Stable thread correlation, surfaced as a sandbox label. */
  readonly threadId: string;
  /** Ports to expose; Daytona exposes on demand, so this is advisory at create. */
  readonly ports: ReadonlyArray<number>;
  /** Resume from a snapshot id rather than a fresh image when set. */
  readonly snapshotId: string | null;
}

export interface DaytonaExecInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Resolved relative to the sandbox root; defaults to the root. */
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

export interface DaytonaExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * A long-lived session process inside the sandbox. The agent (`codex app-server`)
 * runs as one of these: the runtime forwards `stdoutLines`/`stderrLines` into the
 * in-memory JSON-RPC transport and relays the transport's outbound frames back
 * through `writeStdin`. `exit` resolves once, mirroring a local child's exit.
 */
export interface DaytonaSessionProcess {
  readonly stdoutLines: Stream.Stream<string>;
  readonly stderrLines: Stream.Stream<string>;
  readonly writeStdin: (line: string) => Effect.Effect<void>;
  readonly exit: Effect.Effect<ProcessExit>;
  /** Terminate the session process and release its resources. Idempotent. */
  readonly close: Effect.Effect<void>;
}

export interface DaytonaExposePortResult {
  readonly url: string;
}

export interface DaytonaSnapshotResult {
  readonly snapshotId: string;
}

export interface DaytonaSandboxClientShape {
  /**
   * Whether a given sandbox is backed by a real remote sandbox (the REST client)
   * rather than the local fake. The adapter gates host-credential injection on
   * this: the fake runs commands as local child processes sharing the host's real
   * `$HOME`, so injecting `$HOME/.codex/auth.json` there would clobber the
   * developer's own login. A client that backs only remote sandboxes returns
   * `true`; the fake returns `false`; the dispatching client answers per sandbox
   * (real-vs-fake is chosen per provision). Absent means "never remote — do not
   * inject", which keeps the fake/local path side-effect free.
   */
  readonly isRemoteSandbox?: (sandboxId: string) => boolean;
  /** Create (or resume) a sandbox and wait for it to be reachable. */
  readonly create: (input: DaytonaCreateInput) => Effect.Effect<DaytonaSandbox, DaytonaApiError>;
  /** Fire-and-collect command exec inside the sandbox (git rides this). */
  readonly exec: (
    sandboxId: string,
    input: DaytonaExecInput,
  ) => Effect.Effect<DaytonaExecResult, DaytonaApiError | DaytonaSandboxUnknownError>;
  /** Start a long-lived session process (the agent) and stream its stdio. */
  readonly startSession: (
    sandboxId: string,
    input: DaytonaExecInput,
  ) => Effect.Effect<DaytonaSessionProcess, DaytonaApiError | DaytonaSandboxUnknownError>;
  /** Expose a port and return a preview URL. */
  readonly exposePort: (
    sandboxId: string,
    port: number,
  ) => Effect.Effect<DaytonaExposePortResult, DaytonaApiError | DaytonaSandboxUnknownError>;
  /** Snapshot the sandbox for later resume. */
  readonly snapshot: (
    sandboxId: string,
    label: string | null,
  ) => Effect.Effect<DaytonaSnapshotResult, DaytonaApiError | DaytonaSandboxUnknownError>;
  /** Refresh the sandbox's auto-stop timer (the activity-lease keepalive). */
  readonly refreshActivity: (
    sandboxId: string,
  ) => Effect.Effect<void, DaytonaApiError | DaytonaSandboxUnknownError>;
  /** Stop the sandbox without destroying it (FS persists). */
  readonly stop: (
    sandboxId: string,
  ) => Effect.Effect<void, DaytonaApiError | DaytonaSandboxUnknownError>;
  /**
   * Re-attach to a sandbox by id after a restart and report its status. Returns
   * `null` when the provider has no record of the id (a lost instance).
   */
  readonly getStatus: (sandboxId: string) => Effect.Effect<DaytonaSandbox | null, DaytonaApiError>;
  /** Archive then delete the sandbox. Idempotent for an unknown id. */
  readonly destroy: (sandboxId: string) => Effect.Effect<void, DaytonaApiError>;
}

export class DaytonaSandboxClient extends ServiceMap.Service<
  DaytonaSandboxClient,
  DaytonaSandboxClientShape
>()("t3/executionRuntime/providers/daytona/DaytonaSandboxClient") {}
