import { ThreadId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { AgentGatewayShape } from "./Services/AgentGateway.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
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
  type JsonRpcRequest,
} from "./protocol.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";
import { errorText } from "./toolInput.ts";

const MCP_MAX_BATCH_MESSAGES = 50;

export function makeAgentGatewayMcpTransport(input: {
  readonly credentials: AgentGatewayCredentialsShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly instructions: string;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown>;
}): AgentGatewayShape["handleMcpPost"] {
  const toolsByName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));

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
            tools: input.tools.map((tool) => tool.definition),
          });
        case "tools/call": {
          const toolName = request.params.name;
          if (typeof toolName !== "string") {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, "Missing tool name.");
          }
          const tool = toolsByName.get(toolName);
          if (!tool) {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, `Unknown tool "${toolName}".`);
          }
          const rawArgs = request.params.arguments;
          const args =
            typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          const requiredCapability = tool.requiredCapability;
          if (!context.callerCapabilities.has(requiredCapability)) {
            return jsonRpcResult(
              request.id,
              gatewayToolErrorResult(
                new GatewayToolError(
                  "capability_denied",
                  `This provider session is not authorized for ${requiredCapability}.`,
                  { requiredCapability },
                ),
              ),
            );
          }
          const invocationContext: ToolContext = {
            ...context,
            jsonRpcRequestId: request.id,
          };
          if (tool.requiresActiveTurn) {
            const authorityError = yield* context.assertCallerTurnActive().pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => null,
              }),
            );
            if (authorityError !== null) {
              return jsonRpcResult(request.id, gatewayToolErrorResult(authorityError));
            }
          }
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
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
          ),
        };
      }
      const callerThreadId = callerSession.threadId;
      const callerThread = yield* input.snapshotQuery
        .getThreadShellById(ThreadId.makeUnsafe(callerThreadId))
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(callerThread)) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "Bearer token refers to a thread that no longer exists.",
          ),
        };
      }
      const liveProvider = callerThread.value.session?.providerName;
      if ((liveProvider ?? callerThread.value.modelSelection.provider) !== callerSession.provider) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Provider session no longer owns this thread.",
          ),
        };
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
                "This Synara write was rejected because no caller turn was active when the MCP request arrived.",
                { callerThreadId },
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
        return {
          status: 400,
          body: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Empty JSON-RPC batch."),
        };
      }
      if (rawMessages.length > MCP_MAX_BATCH_MESSAGES) {
        return {
          status: 400,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
          ),
        };
      }
      const parsedMessages = rawMessages.map(parseMcpMessage);
      const requestIds = new Set<string>();
      for (const parsed of parsedMessages) {
        if (parsed.kind !== "request") continue;
        const key = `${typeof parsed.request.id}:${String(parsed.request.id)}`;
        if (requestIds.has(key)) {
          return {
            status: 400,
            body: jsonRpcError(
              parsed.request.id,
              JSON_RPC_INVALID_REQUEST,
              `Duplicate JSON-RPC request id ${JSON.stringify(parsed.request.id)} in one batch.`,
            ),
          };
        }
        requestIds.add(key);
      }
      const responses: Array<Record<string, unknown>> = [];
      for (const parsed of parsedMessages) {
        switch (parsed.kind) {
          case "request":
            responses.push(
              yield* handleRequest(parsed.request, context).pipe(
                Effect.catch((error) =>
                  Effect.succeed(
                    jsonRpcResult(parsed.request.id, mcpToolResultError(errorText(error))),
                  ),
                ),
              ),
            );
            break;
          case "notification":
          case "response":
            break;
          case "invalid":
            responses.push(
              jsonRpcError(parsed.id, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC message."),
            );
            break;
        }
      }
      if (responses.length === 0) return { status: 202 };
      return {
        status: 200,
        body: Array.isArray(requestInput.body) ? responses : responses[0],
      };
    });
}
