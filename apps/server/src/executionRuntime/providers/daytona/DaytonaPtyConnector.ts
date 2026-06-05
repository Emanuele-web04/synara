/**
 * Daytona PTY connector - establishes the duplex PTY WebSocket and adapts a real
 * `ws` socket into the {@link DaytonaPtyConnection} the transport drives.
 *
 * The connector owns the two-step PTY lifecycle the transport does not:
 *   1. REST `POST {proxy}/toolbox/{id}/process/pty` to create the PTY session
 *      (returns `{sessionId}`); the daemon attaches a bare interactive shell —
 *      the create-body command is ignored, so codex is launched over stdin by
 *      the transport after connect, not declared here.
 *   2. WS upgrade to `{proxy(ws)}/toolbox/{id}/process/pty/{sessionId}/connect`
 *      with the bearer header (Node sets WS upgrade headers directly), waiting
 *      for the daemon's `{"type":"control","status":"connected"}` control frame
 *      before the socket is considered ready.
 *
 * It returns a `DaytonaPtyConnection` (binary frames -> `data`, text frames
 * parsed as the control envelope, close reason forwarded) injected into
 * {@link makeDaytonaPtySession}. A failure at either step rejects the effect with
 * a `DaytonaApiError`, which the caller catches to fall back to the polling
 * transport - the PTY path never regresses the working default.
 *
 * The `connect` factory is the injection seam: production passes the live
 * implementation here; tests pass a fake that resolves a scripted
 * `DaytonaPtyConnection` without any network.
 *
 * @module daytona/DaytonaPtyConnector
 */
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeWS from "ws";

import { DaytonaApiError } from "./DaytonaErrors.ts";
import type { DaytonaPtyConnection, DaytonaPtyFrame } from "./DaytonaPtyTransport.ts";

export interface DaytonaPtyConnectInput {
  /** Absolute proxy base (no `/api`), e.g. `https://proxy.app.daytona.io`. */
  readonly proxyBaseUrl: string;
  readonly sandboxId: string;
  /** Working directory for the PTY session. */
  readonly cwd: string | undefined;
  /** Environment for the PTY session. */
  readonly envs: Record<string, string> | undefined;
  /** Attach the bearer + org headers (and redact secrets in errors). */
  readonly authorize: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
  /** WS upgrade headers (bearer + org), mirroring the REST auth on Node. */
  readonly wsHeaders: Record<string, string>;
  /** Redact secrets from an error detail. */
  readonly redact: (value: string) => string;
}

/**
 * Open a PTY session and return its duplex connection. The returned effect fails
 * with a `DaytonaApiError` on any REST/upgrade error so the caller can fall back.
 */
export type DaytonaPtyConnect = (
  input: DaytonaPtyConnectInput,
) => Effect.Effect<DaytonaPtyConnection, DaytonaApiError, HttpClient.HttpClient>;

// PTY grid caps: the daemon rejects cols/rows > 1000. A wide grid stops the PTY
// hard-wrapping long JSON-RPC lines (live-verified: program stdout is not
// re-wrapped to terminal width, so this is safe for newline-delimited framing).
const PTY_COLS = 1000;
const PTY_ROWS = 100;

const PtySessionResponseKeys = ["sessionId", "id"] as const;

const readSessionId = (json: unknown): string | undefined => {
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  for (const key of PtySessionResponseKeys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
};

/** Rebuild an http(s) base URL as ws(s) for the WebSocket upgrade. */
const toWebSocketUrl = (httpUrl: string): string =>
  httpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

/**
 * Adapt a `ws` socket into the duplex `DaytonaPtyConnection`. Binary frames
 * become `data`; a text frame is parsed as the control envelope (a malformed one
 * is dropped). The `isBinary` flag is the payload/control discriminator.
 */
const adaptSocket = (socket: NodeWS.WebSocket): DaytonaPtyConnection => ({
  send: (bytes) => socket.send(bytes),
  close: () => socket.close(),
  onFrame: (handler) => {
    socket.on("message", (data: NodeWS.RawData, isBinary: boolean) => {
      if (isBinary) {
        handler({
          _tag: "data",
          bytes: toUint8Array(data),
        } satisfies DaytonaPtyFrame);
        return;
      }
      const text = toUint8Array(data);
      try {
        const parsed = JSON.parse(new TextDecoder().decode(text)) as {
          type?: unknown;
          status?: unknown;
        };
        if (parsed.type === "control" && typeof parsed.status === "string") {
          handler({
            _tag: "control",
            status: parsed.status,
          } satisfies DaytonaPtyFrame);
        }
      } catch {
        // A non-JSON text frame is not a control envelope; drop it rather than
        // inject it into the JSON-RPC stream.
      }
    });
  },
  onClose: (handler) => {
    socket.on("close", (_code: number, reason: Buffer) => handler(reason.toString("utf8")));
  },
});

const toUint8Array = (data: NodeWS.RawData): Uint8Array => {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

/**
 * Live PTY connector: REST-create the PTY session, then open the `ws` socket and
 * resolve once the daemon's `connected` control frame arrives. Any failure (REST
 * non-2xx, upgrade error, error control frame, early close) rejects the effect.
 */
export const liveDaytonaPtyConnect: DaytonaPtyConnect = (input) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const ptyBase = `${input.proxyBaseUrl}/toolbox/${input.sandboxId}/process/pty`;

    // No `command` here: the daemon (v0.184.0) ignores the create-body
    // command/cmd field and attaches a bare interactive shell (live-verified), so
    // codex is launched by writing into the PTY's stdin after connect (see
    // makeDaytonaPtySession). `cwd`/`envs` are still sent in case the daemon
    // honors them; the launch script also re-establishes both, so they are
    // belt-and-suspenders, not load-bearing.
    const createBody: Record<string, unknown> = {
      id: `synara-${crypto.randomUUID()}`,
      cols: PTY_COLS,
      rows: PTY_ROWS,
      lazyStart: false,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.envs === undefined ? {} : { envs: input.envs }),
    };

    const createReq = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(ptyBase),
      createBody,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new DaytonaApiError({
            operation: "startPtySession",
            status: null,
            detail: input.redact(String(cause)),
          }),
      ),
    );
    const response = yield* httpClient.execute(input.authorize(createReq)).pipe(
      Effect.mapError(
        (cause) =>
          new DaytonaApiError({
            operation: "startPtySession",
            status: null,
            detail: input.redact(String(cause)),
          }),
      ),
    );
    if (response.status >= 400) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.fail(
        new DaytonaApiError({
          operation: "startPtySession",
          status: response.status,
          detail: input.redact(body.length === 0 ? `HTTP ${response.status}` : body),
        }),
      );
    }
    const json = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new DaytonaApiError({
            operation: "startPtySession",
            status: response.status,
            detail: input.redact(String(cause)),
          }),
      ),
    );
    const sessionId = readSessionId(json);
    if (sessionId === undefined) {
      return yield* Effect.fail(
        new DaytonaApiError({
          operation: "startPtySession",
          status: response.status,
          detail: "Daytona PTY create returned no session id",
        }),
      );
    }

    const wsUrl = toWebSocketUrl(`${ptyBase}/${sessionId}/connect`);
    return yield* Effect.callback<DaytonaPtyConnection, DaytonaApiError>((resume) => {
      const socket = new NodeWS.WebSocket(wsUrl, {
        headers: input.wsHeaders,
      });
      socket.binaryType = "arraybuffer";
      let settled = false;
      const fail = (detail: string) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          socket.close();
        } catch {
          // already closing
        }
        resume(
          Effect.fail(
            new DaytonaApiError({
              operation: "startPtySession",
              status: null,
              detail: input.redact(detail),
            }),
          ),
        );
      };
      const succeed = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resume(Effect.succeed(adaptSocket(socket)));
      };
      // The daemon's first frame is the `connected` (or `error`) control frame;
      // resolve only once it confirms the PTY attached, so a failed attach falls
      // back to polling instead of returning a dead socket.
      const onMessage = (data: NodeWS.RawData, isBinary: boolean) => {
        if (isBinary) {
          // A binary frame before any control frame still means the PTY is live.
          succeed();
          return;
        }
        try {
          const parsed = JSON.parse(toBufferText(data)) as {
            status?: unknown;
          };
          if (parsed.status === "error") {
            fail(`PTY connect error: ${toBufferText(data)}`);
          } else {
            succeed();
          }
        } catch {
          succeed();
        }
      };
      const onError = (error: Error) => fail(error.message);
      const onClose = () => fail("PTY socket closed before connect");
      const cleanup = () => {
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      socket.on("message", onMessage);
      socket.on("error", onError);
      socket.on("close", onClose);
    });
  });

const toBufferText = (data: NodeWS.RawData): string => new TextDecoder().decode(toUint8Array(data));
