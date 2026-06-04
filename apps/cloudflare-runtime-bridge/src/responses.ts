/**
 * Response helpers shared by the Worker entrypoint and the Durable Object.
 *
 * JSON and NDJSON-stream replies, plus a typed error body matching the contract
 * `BridgeErrorBody`. The NDJSON helper backs the log and file-watch streams: it
 * exposes a `sink` the producer writes line-delimited JSON into, and returns a
 * `Response` whose body drains that sink until the client disconnects.
 *
 * @module responses
 */
import type { BridgeErrorBody } from "@t3tools/contracts";

import type { WorkerWebSocket } from "./cloudflareRuntime.ts";

/**
 * Build the `101 Switching Protocols` reply that hands the client end of a
 * WebSocket pair back to the caller. `status: 101` + `webSocket` are Cloudflare
 * runtime extensions to `ResponseInit`, not in the DOM lib, so this is the one
 * place that escape hatch is centralized.
 *
 * Outside the Worker runtime (tests, Node) a 101 status is not constructible and
 * the `webSocket` init field is dropped, so the client socket is also attached
 * as an own property. Production reads the runtime's `webSocket`; the property is
 * the test-visible handle.
 */
export const webSocketUpgradeResponse = (clientSocket: WorkerWebSocket): Response => {
  const init = { status: 101, webSocket: clientSocket } as unknown as ResponseInit;
  let response: Response;
  try {
    response = new Response(null, init);
  } catch {
    // Node rejects a 101 body-less Response; fall back to a plain marker.
    response = new Response(null, { status: 200, headers: { "x-websocket": "1" } });
  }
  Object.defineProperty(response, "webSocket", {
    value: clientSocket,
    enumerable: false,
    configurable: true,
  });
  return response;
};

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const errorResponse = (status: number, error: string, detail?: string): Response => {
  const body: BridgeErrorBody = { error, detail: detail ?? null };
  return jsonResponse(status, body);
};

/** A writable sink the NDJSON producer pushes typed records into. */
export interface NdjsonSink<T> {
  readonly write: (record: T) => void;
  readonly close: () => void;
}

/**
 * Build an NDJSON streaming `Response`. `register` receives the sink and returns
 * a teardown callback run when the stream closes (client disconnect or close()).
 */
export const ndjsonStreamResponse = <T>(
  register: (sink: NdjsonSink<T>) => () => void,
): Response => {
  const encoder = new TextEncoder();
  let teardown: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const sink: NdjsonSink<T> = {
        write: (record) => {
          if (closed) {
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
        },
        close: () => {
          if (closed) {
            return;
          }
          closed = true;
          controller.close();
        },
      };
      teardown = register(sink);
    },
    cancel() {
      teardown?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
};
