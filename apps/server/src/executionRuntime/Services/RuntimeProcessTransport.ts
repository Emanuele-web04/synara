/**
 * RuntimeProcessTransport - Server-internal boundary for creating the
 * JSON-RPC line transport a provider session runs against, regardless of where
 * the process lives (local child process or remote exec channel).
 *
 * It returns the same `JsonRpcLineTransport` value the Codex transport
 * extraction already produces (`provider/process/JsonRpcLineTransport.ts`),
 * so a remote runtime plugs in by supplying an in-memory transport whose
 * queues an adapter forwards to/from the remote channel. No correlation or
 * protocol logic lives here.
 *
 * @module RuntimeProcessTransport
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  JsonRpcLineTransport,
  TransportClosedError,
} from "../../provider/process/JsonRpcLineTransport.ts";

export interface RuntimeProcessSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

export interface RuntimeProcessTransportShape {
  /** Create a line transport for a process to run inside the given instance. */
  readonly create: (
    input: RuntimeProcessSpawnInput,
  ) => Effect.Effect<JsonRpcLineTransport, TransportClosedError>;
}

export class RuntimeProcessTransport extends ServiceMap.Service<
  RuntimeProcessTransport,
  RuntimeProcessTransportShape
>()("t3/executionRuntime/Services/RuntimeProcessTransport") {}
