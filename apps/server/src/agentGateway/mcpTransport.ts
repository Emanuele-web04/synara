import { ThreadId, type OrchestrationThreadShell } from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { AgentGatewayShape } from "./Services/AgentGateway.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry.ts";
import { extractBearerToken } from "./bearerToken.ts";
import {
  buildMcpInitializeResult,
  jsonRpcError,
  jsonRpcResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  mcpToolResultError,
  parseMcpMessage,
  type JsonRpcId,
  type JsonRpcRequest,
} from "./protocol.ts";
import { sanitizeToolInputSchema } from "./sanitizeToolInputSchema.ts";
import {
  filterToolsByCapability,
  GatewayToolError,
  gatewayToolErrorResult,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";
import { errorText } from "./toolInput.ts";

const MCP_MAX_BATCH_MESSAGES = 50;

type McpJsonRpcResponse = Record<string, unknown>;

type McpResponseSlot =
  | { readonly kind: "immediate"; readonly response: McpJsonRpcResponse }
  | {
      readonly kind: "request";
      readonly fiber: Fiber.Fiber<McpJsonRpcResponse, never>;
    }
  | { readonly kind: "none" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalidRequestResponse(
  status: number,
  message: string,
  id: JsonRpcId = null,
): { readonly status: number; readonly body: McpJsonRpcResponse } {
  return {
    status,
    body: jsonRpcError(id, JSON_RPC_INVALID_REQUEST, message),
  };
}

/**
 * Authority 401s: the credential itself is unusable, so there is no tool call
 * to deny and `onCapabilityDenied` must never fire from these paths. Each body
 * carries a machine-readable `data.code` plus the retry rule in prose:
 *
 * - `revoked-token`: missing, revoked, or invalid credential. Do not retry
 *   with the same token; revoke the lease and re-lease a fresh session.
 * - `thread-gone`: the bearer names a thread that no longer exists. Do not
 *   retry; the thread is gone for good.
 * - `provider-mismatch`: a live thread owned by another provider session. Do
 *   not retry with this token; re-lease ownership before calling again.
 */
type AgentGatewayAuthorityFailureCode = "revoked-token" | "thread-gone" | "provider-mismatch";

function invalidSessionResponse(
  code: AgentGatewayAuthorityFailureCode,
  message: string,
  retry: "reauthenticate" | "do-not-retry" | "re-lease",
): { readonly status: number; readonly body: McpJsonRpcResponse } {
  return {
    status: 401,
    body: {
      ...jsonRpcError(null, JSON_RPC_INVALID_REQUEST, message),
      // jsonRpcError shapes only code/message; the structured detail rides in
      // `data` beside them rather than in a second error convention.
      data: { code, retry },
    },
  };
}

function requestIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export function makeAgentGatewayMcpTransport(input: {
  readonly credentials: AgentGatewayCredentialsShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly instructions: string;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown>;
  // Lets the gateway surface a capability denial to the user (e.g. as a thread
  // activity). Must not fail; the denial response is returned regardless.
  // Fires only for tool-call denials — never for authority 401s, which carry
  // their own structured retry detail instead.
  readonly onCapabilityDenied?: (denial: {
    readonly toolName: string;
    readonly requiredCapability: string;
    readonly callerThreadId: string;
    readonly callerTurnId: string | null;
  }) => Effect.Effect<void>;
  /**
   * Names the computer tool family from the unfiltered input.tools catalog so
   * a caller whose session was never granted computer control still gets a
   * capability_denied (plus the denial hook) when it calls one by name —
   * instead of an Unknown-tool error — even when that tool is absent from the
   * served catalog. Entirely-unknown names still stay INVALID_PARAMS.
   * Mirrors onCapabilityDenied: the call site owns the family (and its
   * capability value); the transport stays generic.
   */
  readonly isComputerToolName?: (toolName: string) => boolean;
  readonly computerControlCapability?: AgentGatewayCapability;
}): AgentGatewayShape["handleMcpPost"] {
  const toolsByName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));
  // The catalog is immutable after construction, so the sanitized `tools/list`
  // definitions (a recursive schema walk plus JSON clone per tool) are computed
  // once here instead of on every request.
  const servedDefinitionByToolName = new Map<string, ToolEntry["definition"]>();
  for (const tool of input.tools) {
    servedDefinitionByToolName.set(tool.definition.name, {
      ...tool.definition,
      // SAFETY: ToolEntry.inputSchema is typed Record<string, unknown>; the sanitizer
      // returns a fresh object for object input, so this restores the static type.
      inputSchema: sanitizeToolInputSchema(tool.definition.inputSchema) as Record<string, unknown>,
    });
  }
  const handleRequest = (request: JsonRpcRequest, context: Omit<ToolContext, "jsonRpcRequestId">) =>
    Effect.gen(function* () {
      switch (request.method) {
        case "initialize":
          return jsonRpcResult(
            request.id,
            buildMcpInitializeResult({
              requestedProtocolVersion: request.params.protocolVersion,
              serverVersion: "1.0.0",
              instructions: input.instructions,
            }),
          );
        case "ping":
          return jsonRpcResult(request.id, {});
        case "tools/list":
          return jsonRpcResult(request.id, {
            tools: filterToolsByCapability(input.tools, context.callerCapabilities)
              // Discovery-only tools stay callable by exact name — toolsByName
              // is built from the unfiltered catalog — but do not advertise.
              .filter((tool) => tool.discoveryOnly !== true)
              .map(
                (tool) =>
                  servedDefinitionByToolName.get(tool.definition.name) ?? {
                    ...tool.definition,
                    inputSchema: sanitizeToolInputSchema(tool.definition.inputSchema) as Record<
                      string,
                      unknown
                    >,
                  },
              ),
          });
        case "tools/call": {
          const toolName = request.params.name;
          if (typeof toolName !== "string") {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, "Missing tool name.");
          }
          const readCallerAuthorityError = () =>
            context.assertCallerTurnActive().pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => null,
              }),
            );
          const capabilityDeniedResult = (requiredCapability: string) =>
            jsonRpcResult(
              request.id,
              gatewayToolErrorResult(
                new GatewayToolError(
                  "capability_denied",
                  `This provider session is not authorized for ${requiredCapability}.`,
                  { requiredCapability },
                ),
              ),
            );
          const tool = toolsByName.get(toolName);
          if (!tool) {
            // Entirely-unknown names stay INVALID_PARAMS — except a computer
            // tool the caller's session was never granted: that is a
            // capability truth, not a typo, so it denies like a known one.
            const computerControlCapability = input.computerControlCapability;
            if (
              computerControlCapability === undefined ||
              context.callerCapabilities.has(computerControlCapability) ||
              input.isComputerToolName?.(toolName) !== true
            ) {
              return jsonRpcError(
                request.id,
                JSON_RPC_INVALID_PARAMS,
                `Unknown tool "${toolName}".`,
              );
            }
            // Computer tools need an active turn: an inactive turn reports the
            // authority error and never fires the denial hook.
            const authorityError = yield* readCallerAuthorityError();
            if (authorityError !== null) {
              return jsonRpcResult(request.id, gatewayToolErrorResult(authorityError));
            }
            if (input.onCapabilityDenied) {
              yield* input.onCapabilityDenied({
                toolName,
                requiredCapability: computerControlCapability,
                callerThreadId: context.callerThreadId,
                callerTurnId: context.callerTurnId,
              });
            }
            return capabilityDeniedResult(computerControlCapability);
          }
          const rawArgs = request.params.arguments;
          const args = asRecord(rawArgs) ?? {};
          // Turn-active first: an inactive turn reports the authority error
          // and never fires the denial hook, even for a tool whose capability
          // the caller also lacks.
          if (tool.requiresActiveTurn) {
            const authorityError = yield* readCallerAuthorityError();
            if (authorityError !== null) {
              return jsonRpcResult(request.id, gatewayToolErrorResult(authorityError));
            }
          }
          const requiredCapability = tool.requiredCapability;
          if (!context.callerCapabilities.has(requiredCapability)) {
            if (input.onCapabilityDenied) {
              yield* input.onCapabilityDenied({
                toolName,
                requiredCapability,
                callerThreadId: context.callerThreadId,
                callerTurnId: context.callerTurnId,
              });
            }
            return capabilityDeniedResult(requiredCapability);
          }
          const invocationContext: ToolContext = {
            ...context,
            jsonRpcRequestId: request.id,
          };
          const result = yield* Effect.suspend(() => tool.handler(args, invocationContext)).pipe(
            Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
          );
          return jsonRpcResult(request.id, result);
        }
        default:
          return jsonRpcError(
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Method "${request.method}" is not supported.`,
          );
      }
    });

  return (requestInput) =>
    Effect.gen(function* () {
      const token = extractBearerToken(requestInput.authorizationHeader);
      const callerSession = token ? input.credentials.verifySession(token) : null;
      if (!token || !callerSession) {
        return invalidSessionResponse(
          "revoked-token",
          "caller_session_inactive: Missing, revoked, or invalid provider-session credential. Do not retry with this token; revoke the lease and re-lease a fresh provider session.",
          "reauthenticate",
        );
      }
      const callerThreadId = callerSession.threadId;
      const callerThread = yield* input.snapshotQuery
        .getThreadShellById(ThreadId.makeUnsafe(callerThreadId))
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(callerThread)) {
        return invalidSessionResponse(
          "thread-gone",
          "Bearer token refers to a thread that no longer exists. Do not retry; the thread is gone.",
          "do-not-retry",
        );
      }
      const liveProvider = callerThread.value.session?.providerName;
      if ((liveProvider ?? callerThread.value.modelSelection.provider) !== callerSession.provider) {
        return invalidSessionResponse(
          "provider-mismatch",
          "caller_session_inactive: Provider session no longer owns this thread. Do not retry with this token; re-lease thread ownership before calling again.",
          "re-lease",
        );
      }
      const callerWriteAuthority =
        callerThread.value.latestTurn?.state === "running"
          ? input.credentials.bindWriteAuthority(token, callerThread.value.latestTurn.turnId)
          : null;
      const assertCallerTurnActive = () =>
        Effect.gen(function* () {
          if (callerWriteAuthority === null) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Synara write was rejected because this credential had no write authority for the exact active turn when the MCP request arrived.",
                {
                  callerThreadId,
                  latestTurnId: callerThread.value.latestTurn?.turnId ?? null,
                },
              ),
            );
          }
          if (!input.credentials.verifyWriteAuthority(callerWriteAuthority)) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_session_inactive",
                "This Synara write was rejected because its provider-session authority is no longer active.",
                { callerThreadId },
              ),
            );
          }
          const caller = yield* input
            .requireThreadShell(callerThreadId)
            .pipe(
              Effect.mapError(
                (error) =>
                  new GatewayToolError(
                    "caller_turn_inactive",
                    "This Synara write was rejected because the caller thread could no longer be verified.",
                    { callerThreadId, error: errorText(error) },
                  ),
              ),
            );
          if (
            caller.latestTurn?.state !== "running" ||
            caller.latestTurn.turnId !== callerWriteAuthority.turnId
          ) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Synara write was rejected because the turn that received this MCP request is no longer active. In-flight requests cannot inherit authority from a later turn.",
                {
                  callerThreadId,
                  authorizedTurnId: callerWriteAuthority.turnId,
                  latestTurnId: caller.latestTurn?.turnId ?? null,
                  latestTurnState: caller.latestTurn?.state ?? null,
                },
              ),
            );
          }
        });
      const context: Omit<ToolContext, "jsonRpcRequestId"> = {
        principal: {
          kind: "provider-session",
          sessionKey: callerSession.sessionKey,
          threadId: callerThreadId,
          provider: callerSession.provider,
          turnId: callerWriteAuthority?.turnId ?? null,
        },
        callerThreadId,
        // The nickname first: a subagent that has one is known by it, and its
        // title describes the work rather than who is doing it.
        callerThreadLabel: callerThread.value.subagentNickname ?? callerThread.value.title ?? null,
        callerSessionKey: callerSession.sessionKey,
        callerProvider: callerSession.provider,
        callerCapabilities: callerSession.capabilities,
        callerTurnId: callerWriteAuthority?.turnId ?? null,
        assertCallerTurnActive,
      };

      const rawMessages = Array.isArray(requestInput.body)
        ? requestInput.body
        : [requestInput.body];
      if (rawMessages.length === 0) {
        return invalidRequestResponse(400, "Empty JSON-RPC batch.");
      }
      if (rawMessages.length > MCP_MAX_BATCH_MESSAGES) {
        return invalidRequestResponse(
          400,
          `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
        );
      }
      const parsedMessages = rawMessages.map(parseMcpMessage);
      const requestIds = new Set<string>();
      for (const parsed of parsedMessages) {
        if (parsed.kind !== "request") continue;
        const key = requestIdKey(parsed.request.id);
        if (requestIds.has(key)) {
          return invalidRequestResponse(
            400,
            `Duplicate JSON-RPC request id ${JSON.stringify(parsed.request.id)} in one batch.`,
            parsed.request.id,
          );
        }
        requestIds.add(key);
      }
      const responseSlots: McpResponseSlot[] = [];
      const cancellationRequestIds: Array<string | number> = [];

      // Start every request before awaiting any of them. Apart from avoiding
      // head-of-line blocking for ordinary batches, this guarantees that a
      // cancellation notification in the same batch can see its target even
      // when the notification appears first.
      for (const parsed of parsedMessages) {
        switch (parsed.kind) {
          case "request": {
            const registered = yield* Deferred.make<void>();
            let unregister: () => void = () => undefined;
            let requestStarted = false;
            let cancellationRequested = false;
            const requestEffect = Deferred.await(registered).pipe(
              Effect.andThen(handleRequest(parsed.request, context)),
              Effect.catch((error) =>
                Effect.succeed(
                  jsonRpcResult(parsed.request.id, mcpToolResultError(errorText(error))),
                ),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  unregister();
                }),
              ),
            );
            const fiber = yield* requestEffect.pipe(Effect.forkChild({ startImmediately: true }));
            unregister = input.credentials.registerInFlightRequest({
              sessionKey: callerSession.sessionKey,
              turnId: context.callerTurnId,
              requestId: parsed.request.id,
              cancel: () => {
                cancellationRequested = true;
                if (!requestStarted) return Promise.resolve();
                return new Promise<void>((resolve) => {
                  // Avoid interrupting re-entrantly while an async Effect is
                  // still installing its AbortController finalizer. The fiber
                  // observer is the cleanup barrier returned to Stop.
                  queueMicrotask(() => {
                    if (fiber.pollUnsafe() !== undefined) {
                      resolve();
                      return;
                    }
                    fiber.addObserver(() => resolve());
                    fiber.interruptUnsafe();
                  });
                });
              },
            });
            if (cancellationRequested) {
              // A terminal-turn tombstone cancelled this request during
              // registration. The handler is still fenced behind `registered`,
              // so a direct interruption is safe and no browser work can start.
              fiber.interruptUnsafe();
            } else {
              requestStarted = true;
              yield* Deferred.succeed(registered, undefined);
            }
            responseSlots.push({ kind: "request", fiber });
            break;
          }
          case "notification": {
            if (parsed.notification.method === "notifications/cancelled") {
              const cancelledId = parsed.notification.params.requestId;
              if (typeof cancelledId === "string" || typeof cancelledId === "number") {
                cancellationRequestIds.push(cancelledId);
              }
            }
            responseSlots.push({ kind: "none" });
            break;
          }
          case "response":
            responseSlots.push({ kind: "none" });
            break;
          case "invalid":
            responseSlots.push({
              kind: "immediate",
              response: jsonRpcError(
                parsed.id,
                JSON_RPC_INVALID_REQUEST,
                "Invalid JSON-RPC message.",
              ),
            });
            break;
        }
      }

      for (const cancelledId of cancellationRequestIds) {
        input.credentials.cancelInFlightRequests({
          sessionKey: callerSession.sessionKey,
          requestId: cancelledId,
        });
      }

      const resolvedResponses = yield* Effect.forEach(
        responseSlots,
        (slot) => {
          if (slot.kind === "none") return Effect.succeed(null);
          if (slot.kind === "immediate") return Effect.succeed(slot.response);
          return Fiber.await(slot.fiber).pipe(
            Effect.map((exit) =>
              Exit.match(exit, {
                onFailure: (cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? null
                    : jsonRpcResult(null, mcpToolResultError(Cause.pretty(cause))),
                onSuccess: (response) => response,
              }),
            ),
          );
        },
        { concurrency: "unbounded" },
      );
      const responses = resolvedResponses.filter(
        (response): response is McpJsonRpcResponse => response !== null,
      );
      if (responses.length === 0) return { status: 202 };
      return {
        status: 200,
        body: Array.isArray(requestInput.body) ? responses : responses[0],
      };
    });
}
