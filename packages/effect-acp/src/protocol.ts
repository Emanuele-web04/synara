// FILE: protocol.ts
// Purpose: Bridges ACP JSON-RPC over stdio into Effect RPC while patching agent wire quirks.
// Layer: effect-acp transport
// Exports: makeAcpPatchedProtocol plus inbound notification/request helpers.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed" | "dropped";
  readonly payload: unknown;
}

export type AcpIncomingNotification =
  | {
      readonly _tag: "SessionUpdate";
      readonly method: typeof CLIENT_METHODS.session_update;
      readonly params: typeof AcpSchema.SessionNotification.Type;
    }
  | {
      readonly _tag: "ElicitationComplete";
      readonly method: typeof CLIENT_METHODS.session_elicitation_complete;
      readonly params: typeof AcpSchema.ElicitationCompleteNotification.Type;
    }
  | {
      readonly _tag: "ExtNotification";
      readonly method: string;
      readonly params: unknown;
    };

export interface AcpPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<AcpError.AcpError>;
  readonly serverRequestMethods: ReadonlySet<string>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError, never>;
  readonly onExtRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError, never>;
  readonly onTermination?: (error: AcpError.AcpError) => Effect.Effect<void, never, never>;
}

export interface AcpPatchedProtocol {
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverProtocol: RpcServer.Protocol["Service"];
  readonly incoming: Stream.Stream<AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
}

const decodeSessionUpdate = Schema.decodeUnknownEffect(AcpSchema.SessionNotification);
const decodeElicitationComplete = Schema.decodeUnknownEffect(
  AcpSchema.ElicitationCompleteNotification,
);
const parserFactory = RpcSerialization.ndJsonRpc();

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEffectNumericRequestId(requestId: string): boolean {
  return /^-?\d+$/u.test(requestId);
}

function shouldKeepAwayFromEffectRpc(requestId: string): boolean {
  return requestId !== "" && !isEffectNumericRequestId(requestId);
}

function isExpectedUntrackedStringResponseId(requestId: string): boolean {
  return requestId === "skills-reload";
}

export const makeAcpPatchedProtocol = Effect.fn("makeAcpPatchedProtocol")(function* (
  options: AcpPatchedProtocolOptions,
): Effect.fn.Return<AcpPatchedProtocol, never, Scope.Scope> {
  const parser = parserFactory.makeUnsafe();
  const serverQueue = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
  const clientQueue = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
  const notificationQueue = yield* Queue.unbounded<AcpIncomingNotification>();
  const disconnects = yield* Queue.unbounded<number>();
  const outgoing = yield* Queue.unbounded<string | Uint8Array, Cause.Done<void>>();
  const nextRequestId = yield* Ref.make(1n);
  const terminationHandled = yield* Ref.make(false);
  const incomingDecoder = new TextDecoder();
  let incomingTextBuffer = "";
  // JSON-RPC discourages null request IDs, but the official ACP SDK accepts
  // them. Keep the exact wire value so responses and cancellation still
  // correlate without collapsing null, 0, "0", or "" into one another.
  type WireRequestId = string | number | null;
  const isWireRequestId = (value: unknown): value is WireRequestId =>
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
  const inboundWireRequestIds = new Map<string, WireRequestId>();
  const inboundCorrelationIdByWireId = new Map<string, string>();
  let nextInboundCorrelationId = -1n;
  const extPending = yield* Ref.make(
    new Map<string, Deferred.Deferred<unknown, AcpError.AcpError>>(),
  );

  const stderrOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Logger.LogToStderr, true);

  const logProtocol = (event: AcpProtocolLogEvent) => {
    if (event.direction === "incoming" && !options.logIncoming) {
      return Effect.void;
    }
    if (event.direction === "outgoing" && !options.logOutgoing) {
      return Effect.void;
    }
    return (
      options.logger?.(event) ??
      stderrOnly(Effect.logDebug("ACP protocol event").pipe(Effect.annotateLogs({ event })))
    );
  };

  const wireRequestIdKey = (requestId: WireRequestId): string =>
    requestId === null ? "null" : `${typeof requestId}:${requestId}`;

  const rememberInboundRequestId = (wireId: WireRequestId): string => {
    // Effect RPC parses request IDs as BigInt internally. Negative decimal IDs
    // remain valid to it while staying disjoint from locally generated IDs.
    const correlationId = String(nextInboundCorrelationId--);
    inboundWireRequestIds.set(correlationId, wireId);
    inboundCorrelationIdByWireId.set(wireRequestIdKey(wireId), correlationId);
    return correlationId;
  };

  const wireIdForRequestId = (requestId: string): WireRequestId => {
    const inboundId = inboundWireRequestIds.get(requestId);
    if (inboundId !== undefined) {
      inboundWireRequestIds.delete(requestId);
      inboundCorrelationIdByWireId.delete(wireRequestIdKey(inboundId));
      return inboundId;
    }
    return isEffectNumericRequestId(requestId) ? Number(requestId) : requestId;
  };

  const wireIdForGeneratedRequestId = (requestId: string): string | number =>
    isEffectNumericRequestId(requestId) ? Number(requestId) : requestId;

  const encodeAcpMessage = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): string | Uint8Array | undefined => {
    switch (message._tag) {
      case "Request":
        return `${JSON.stringify({
          jsonrpc: "2.0",
          method: message.tag,
          params: message.payload,
          ...(message.id === "" ? {} : { id: wireIdForGeneratedRequestId(message.id) }),
        })}\n`;
      case "Interrupt":
        return `${JSON.stringify({
          jsonrpc: "2.0",
          method: "$/cancel_request",
          params: { requestId: wireIdForGeneratedRequestId(message.requestId) },
        })}\n`;
      case "Exit": {
        const id = wireIdForRequestId(message.requestId);
        if (message.exit._tag === "Success") {
          return `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: message.exit.value ?? null,
          })}\n`;
        }
        const failure = message.exit.cause.find((entry) => entry._tag === "Fail");
        return `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error:
            failure && isProtocolError(failure.error)
              ? failure.error
              : AcpError.AcpRequestError.internalError("ACP request failed").toProtocolError(),
        })}\n`;
      }
      default:
        return parser.encode(message);
    }
  };

  // Buffer complete top-level NDJSON messages so split UTF-8 chunks remain intact.
  const collectCompleteInput = (data: string | Uint8Array): string | undefined => {
    incomingTextBuffer +=
      typeof data === "string" ? data : incomingDecoder.decode(data, { stream: true });
    const lastNewlineIndex = incomingTextBuffer.lastIndexOf("\n");
    if (lastNewlineIndex < 0) {
      return undefined;
    }
    const completeText = incomingTextBuffer.slice(0, lastNewlineIndex + 1);
    incomingTextBuffer = incomingTextBuffer.slice(lastNewlineIndex + 1);
    return completeText;
  };

  const flushBufferedInput = (): string | undefined => {
    incomingTextBuffer += incomingDecoder.decode();
    if (incomingTextBuffer.trim().length === 0) {
      incomingTextBuffer = "";
      return undefined;
    }
    const completeText = `${incomingTextBuffer}\n`;
    incomingTextBuffer = "";
    return completeText;
  };

  const offerOutgoing = Effect.fn("offerOutgoing")(function* (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ) {
    yield* logProtocol({
      direction: "outgoing",
      stage: "decoded",
      payload: message,
    });

    const encoded = yield* Effect.try({
      try: () => encodeAcpMessage(message),
      catch: (cause) =>
        new AcpError.AcpProtocolParseError({
          detail: "Failed to encode ACP message",
          cause,
        }),
    });

    if (encoded) {
      yield* logProtocol({
        direction: "outgoing",
        stage: "raw",
        payload: typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
      });

      yield* Queue.offer(outgoing, encoded).pipe(Effect.asVoid);
    }
  });

  const resolveExtPending = (
    requestId: string,
    onFound: (deferred: Deferred.Deferred<unknown, AcpError.AcpError>) => Effect.Effect<void>,
  ) =>
    Ref.modify(extPending, (pending) => {
      const deferred = pending.get(requestId);
      if (!deferred) {
        return [Effect.void, pending] as const;
      }
      const next = new Map(pending);
      next.delete(requestId);
      return [onFound(deferred), next] as const;
    }).pipe(Effect.flatten);

  const removeExtPending = (requestId: string) =>
    Ref.update(extPending, (pending) => {
      if (!pending.has(requestId)) {
        return pending;
      }
      const next = new Map(pending);
      next.delete(requestId);
      return next;
    });

  const completeExtPendingFailure = (requestId: string, error: AcpError.AcpError) =>
    resolveExtPending(requestId, (deferred) => Deferred.fail(deferred, error));

  const completeExtPendingSuccess = (requestId: string, value: unknown) =>
    resolveExtPending(requestId, (deferred) => Deferred.succeed(deferred, value));

  const failAllExtPending = (error: AcpError.AcpError) =>
    Ref.getAndSet(extPending, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach([...pending.values()], (deferred) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const dispatchNotification = (notification: AcpIncomingNotification) =>
    Queue.offer(notificationQueue, notification).pipe(
      Effect.andThen(
        options.onNotification
          ? options.onNotification(notification).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const emitClientProtocolError = (error: AcpError.AcpError) =>
    Queue.offer(clientQueue, {
      _tag: "ClientProtocolError",
      error: new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: error.message,
          cause: error,
        }),
      }),
    }).pipe(Effect.asVoid);

  const handleTermination = (classify: () => Effect.Effect<AcpError.AcpError | undefined>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          yield* Queue.offer(disconnects, 0);
          const error = yield* classify();
          if (!error) {
            return;
          }
          yield* failAllExtPending(error);
          yield* emitClientProtocolError(error);
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const respondWithSuccess = (requestId: string, value: unknown) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Success",
        value,
      },
    });

  const respondWithError = (requestId: string, error: AcpError.AcpRequestError) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: error.toProtocolError(),
          },
        ],
      },
    });

  // Keep all ACP responses on the same exact-ID encoder path.
  const offerServerProtocolResponse = Effect.fn("offerServerProtocolResponse")(function* (
    response: RpcMessage.FromServerEncoded,
  ) {
    yield* offerOutgoing(response);
  });

  const handleExtRequest = (message: RpcMessage.RequestEncoded) => {
    if (!options.onExtRequest) {
      return respondWithError(message.id, AcpError.AcpRequestError.methodNotFound(message.tag));
    }
    return options.onExtRequest(message.tag, message.payload).pipe(
      Effect.matchEffect({
        onFailure: (error) => respondWithError(message.id, normalizeToRequestError(error)),
        onSuccess: (value) => respondWithSuccess(message.id, value),
      }),
    );
  };

  const handleRequestEncoded = (message: RpcMessage.RequestEncoded) => {
    if (message.id === "") {
      if (message.tag === CLIENT_METHODS.session_update) {
        return decodeSessionUpdate(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "SessionUpdate",
                method: CLIENT_METHODS.session_update,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError(
            (cause) =>
              new AcpError.AcpProtocolParseError({
                detail: `Invalid ${CLIENT_METHODS.session_update} notification payload`,
                cause,
              }),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      if (message.tag === CLIENT_METHODS.session_elicitation_complete) {
        return decodeElicitationComplete(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "ElicitationComplete",
                method: CLIENT_METHODS.session_elicitation_complete,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError(
            (cause) =>
              new AcpError.AcpProtocolParseError({
                detail: `Invalid ${CLIENT_METHODS.session_elicitation_complete} notification payload`,
                cause,
              }),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      return dispatchNotification({
        _tag: "ExtNotification",
        method: message.tag,
        params: message.payload,
      });
    }

    if (!options.serverRequestMethods.has(message.tag)) {
      return handleExtRequest(message).pipe(
        Effect.catch(() => respondWithError(message.id, AcpError.AcpRequestError.internalError())),
        Effect.asVoid,
      );
    }

    return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
  };

  const handleExitEncoded = (message: RpcMessage.ResponseExitEncoded) =>
    Ref.get(extPending).pipe(
      Effect.flatMap((pending) => {
        if (!pending.has(message.requestId)) {
          if (shouldKeepAwayFromEffectRpc(message.requestId)) {
            const payload = {
              reason: "untracked-string-response-id",
              requestId: message.requestId,
              message,
            };
            const logDropped = isExpectedUntrackedStringResponseId(message.requestId)
              ? Effect.logDebug
              : Effect.logWarning;
            return stderrOnly(
              logDropped("acp.protocol.dropped", {
                reason: payload.reason,
                requestId: payload.requestId,
              }),
            ).pipe(
              Effect.andThen(
                logProtocol({
                  direction: "incoming",
                  stage: "dropped",
                  payload,
                }),
              ),
            );
          }
          return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
        }
        if (message.exit._tag === "Success") {
          return completeExtPendingSuccess(message.requestId, message.exit.value);
        }
        const failure = message.exit.cause.find((entry) => entry._tag === "Fail");
        if (failure && isProtocolError(failure.error)) {
          return completeExtPendingFailure(
            message.requestId,
            AcpError.AcpRequestError.fromProtocolError(failure.error),
          );
        }
        return completeExtPendingFailure(
          message.requestId,
          AcpError.AcpRequestError.internalError("Extension request failed"),
        );
      }),
    );

  const routeDecodedMessage = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): Effect.Effect<void, AcpError.AcpError> => {
    switch (message._tag) {
      case "Request":
        return handleRequestEncoded(message);
      case "Exit":
        return handleExitEncoded(message);
      case "Chunk":
        return Ref.get(extPending).pipe(
          Effect.flatMap((pending) =>
            pending.has(message.requestId)
              ? completeExtPendingFailure(
                  message.requestId,
                  AcpError.AcpRequestError.internalError(
                    "Streaming extension responses are not supported",
                  ),
                )
              : shouldKeepAwayFromEffectRpc(message.requestId)
                ? (() => {
                    const payload = {
                      reason: "untracked-string-chunk-id",
                      requestId: message.requestId,
                      message,
                    };
                    return stderrOnly(
                      Effect.logWarning("acp.protocol.dropped", {
                        reason: payload.reason,
                        requestId: payload.requestId,
                      }),
                    ).pipe(
                      Effect.andThen(
                        logProtocol({
                          direction: "incoming",
                          stage: "dropped",
                          payload,
                        }),
                      ),
                    );
                  })()
                : Queue.offer(clientQueue, message).pipe(Effect.asVoid),
          ),
        );
      case "Defect":
      case "ClientProtocolError":
      case "Pong":
        return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
      case "Ack":
      case "Interrupt":
      case "Ping":
      case "Eof":
        return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
    }
  };

  const decodeJsonRpcMessage = (
    value: unknown,
  ): ReadonlyArray<RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded> => {
    if (Array.isArray(value)) {
      return value.flatMap(decodeJsonRpcMessage);
    }
    if (!isJsonObject(value) || value.jsonrpc !== "2.0") {
      throw new Error("Invalid ACP JSON-RPC message");
    }
    if (typeof value.method === "string") {
      if (value.method === "$/cancel_request") {
        const id = isJsonObject(value.params) ? value.params.requestId : undefined;
        if (!isWireRequestId(id)) {
          throw new Error("Invalid $/cancel_request requestId");
        }
        const correlationId = inboundCorrelationIdByWireId.get(wireRequestIdKey(id));
        if (correlationId === undefined) {
          // Unknown and late wire cancellations must not enter Effect's
          // reserved internal request-ID namespace.
          return [];
        }
        return [
          {
            _tag: "Interrupt",
            requestId: correlationId,
          },
        ];
      }
      const wireId = value.id;
      const hasRequestId = Object.hasOwn(value, "id");
      if (hasRequestId && !isWireRequestId(wireId)) {
        throw new Error("Invalid ACP JSON-RPC request id");
      }
      const requestId = hasRequestId
        ? rememberInboundRequestId(wireId as WireRequestId)
        : "";
      return [
        {
          _tag: "Request",
          id: requestId,
          tag: value.method,
          payload: value.params ?? {},
          headers: [],
        },
      ];
    }
    if (!isWireRequestId(value.id)) {
      throw new Error("Invalid ACP JSON-RPC response id");
    }
    const requestId = String(value.id);
    if ("result" in value) {
      return [
        {
          _tag: "Exit",
          requestId,
          exit: { _tag: "Success", value: value.result },
        },
      ];
    }
    if (isProtocolError(value.error)) {
      return [
        {
          _tag: "Exit",
          requestId,
          exit: {
            _tag: "Failure",
            cause: [{ _tag: "Fail", error: value.error }],
          },
        },
      ];
    }
    throw new Error("Invalid ACP JSON-RPC response");
  };

  const decodeWireData = (data: string | Uint8Array | undefined) =>
    Effect.try({
      try: () => {
        if (data === undefined) {
          return [];
        }
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        return text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .flatMap((line) => decodeJsonRpcMessage(JSON.parse(line)));
      },
      catch: (cause) =>
        new AcpError.AcpProtocolParseError({
          detail: "Failed to decode ACP wire message",
          cause,
        }),
    });

  const routeDecodedMessages = (
    messages: ReadonlyArray<RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded>,
  ) =>
    Effect.forEach(messages, routeDecodedMessage, {
      discard: true,
    });

  yield* options.stdio.stdin.pipe(
    Stream.runForEach((data) =>
      logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: typeof data === "string" ? data : new TextDecoder().decode(data),
      }).pipe(
        Effect.flatMap(() => decodeWireData(collectCompleteInput(data))),
        Effect.tap((messages) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: messages,
          }),
        ),
        Effect.tapErrorTag("AcpProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              detail: error.detail,
              cause: error.cause,
            },
          }),
        ),
        Effect.flatMap(routeDecodedMessages),
      ),
    ),
    Effect.matchEffect({
      onFailure: (error) => {
        const normalized: AcpError.AcpError = Schema.is(AcpError.AcpError)(error)
          ? error
          : new AcpError.AcpTransportError({
              detail: error instanceof Error ? error.message : String(error),
              cause: error,
            });
        return handleTermination(() => Effect.succeed(normalized));
      },
      onSuccess: () =>
        decodeWireData(flushBufferedInput()).pipe(
          Effect.flatMap(routeDecodedMessages),
          Effect.matchEffect({
            onFailure: (error) => handleTermination(() => Effect.succeed(error)),
            onSuccess: () =>
              handleTermination(
                () =>
                  options.terminationError ??
                  Effect.succeed(
                    new AcpError.AcpTransportError({
                      detail: "ACP input stream ended",
                      cause: new Error("ACP input stream ended"),
                    }),
                  ),
              ),
          }),
        ),
    }),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout), Effect.forkScoped);

  const clientProtocol = RpcClient.Protocol.of({
    run: (f) =>
      Stream.fromQueue(clientQueue).pipe(
        Stream.runForEach((message) => f(message)),
        Effect.forever,
      ),
    send: (request) => offerOutgoing(request).pipe(Effect.mapError(toRpcClientError)),
    supportsAck: true,
    supportsTransferables: false,
  });

  const serverProtocol = RpcServer.Protocol.of({
    run: (f) =>
      Stream.fromQueue(serverQueue).pipe(
        Stream.runForEach((message) => f(0, message)),
        Effect.forever,
      ),
    disconnects,
    send: (_clientId, response) => offerServerProtocolResponse(response).pipe(Effect.orDie),
    end: (_clientId) => Queue.end(outgoing),
    clientIds: Effect.succeed(new Set([0])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: true,
  });

  const sendNotification = Effect.fn("sendNotification")(function* (
    method: string,
    payload: unknown,
  ) {
    yield* offerOutgoing({
      _tag: "Request",
      id: "",
      tag: method,
      payload,
      headers: [],
    });
  });

  const sendRequest = Effect.fn("sendRequest")(function* (method: string, payload: unknown) {
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1n] as const,
    );
    const deferred = yield* Deferred.make<unknown, AcpError.AcpError>();
    yield* Ref.update(extPending, (pending) => new Map(pending).set(String(requestId), deferred));
    yield* offerOutgoing({
      _tag: "Request",
      id: String(requestId),
      tag: method,
      payload,
      headers: [],
    }).pipe(
      Effect.catch((error) =>
        removeExtPending(String(requestId)).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() =>
        removeExtPending(String(requestId)).pipe(
          Effect.andThen(
            offerOutgoing({
              _tag: "Interrupt",
              requestId: String(requestId),
            }),
          ),
        ),
      ),
    );
  });

  return {
    clientProtocol,
    serverProtocol,
    get incoming() {
      return Stream.fromQueue(notificationQueue);
    },
    request: sendRequest,
    notify: sendNotification,
  } satisfies AcpPatchedProtocol;
});

function isProtocolError(
  value: unknown,
): value is { code: number; message: string; data?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function normalizeToRequestError(error: AcpError.AcpError): AcpError.AcpRequestError {
  return Schema.is(AcpError.AcpRequestError)(error)
    ? error
    : AcpError.AcpRequestError.internalError(error.message);
}

function toRpcClientError(error: AcpError.AcpError): RpcClientError.RpcClientError {
  return new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: error.message,
      cause: error,
    }),
  });
}
