import {
  EnvironmentId,
  REMOTE_AGENT_GATEWAY_CAPABILITY,
  RemoteAgentResult,
  ThreadId,
  TurnId,
  WS_METHODS,
  RemoteAgentCall,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { parseComputerInvocation } from "@synara/shared/computerInvocation";
import { Effect, Schema } from "effect";
import type { ServerEnvironmentShape } from "../environment/Services/ServerEnvironment";
import type { HostConnectionRegistry } from "../hostConnections/registry";
import { controllerProtocol } from "../hostConnections/dialer";
import { stableGatewayDigest } from "./creationUtils";
import { mcpToolResultJson, type McpToolCallResult } from "./protocol";
import { errorText, readStringArg } from "./toolInput";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime";

const REMOTE_TOOLS = new Set([
  "synara_capabilities",
  "synara_list_projects",
  "synara_list_threads",
  "synara_read_thread",
  "synara_read_thread_activity",
  "synara_read_thread_events",
  "synara_read_thread_runtime_events",
  "synara_diagnose_thread",
  "synara_wait_for_threads",
  "synara_create_thread",
  "synara_create_threads",
  "synara_send_message",
  "synara_interrupt_thread",
  "synara_set_thread_title",
  "synara_set_thread_pull_request",
  "synara_set_thread_archived",
  "synara_set_thread_goal",
]);

/** Qualify only gateway-owned metadata, never text, diagnostics or arbitrary user objects. */
function qualifyGatewayResult(result: McpToolCallResult, environmentId: string): McpToolCallResult {
  if (result.isError || result.content.length !== 1 || result.content[0]?.type !== "text")
    return result;
  const value = JSON.parse(result.content[0].text);
  const qualify = (row: Record<string, unknown>) => ({
    ...row,
    environmentId,
    ...(row.readThread && typeof row.readThread === "object"
      ? {
          readThread: {
            ...row.readThread,
            arguments: { ...(row.readThread as { arguments: object }).arguments, environmentId },
          },
        }
      : {}),
  });
  return mcpToolResultJson({
    ...value,
    environmentId,
    ...(Array.isArray(value.projects) ? { projects: value.projects.map(qualify) } : {}),
    ...(Array.isArray(value.threads) ? { threads: value.threads.map(qualify) } : {}),
    ...(value.caller ? { caller: qualify(value.caller) } : {}),
  });
}

export interface RemoteGatewayDependencies {
  readonly assertRemoteWriteAllowed: (callerThreadId: string) => Effect.Effect<void, unknown>;
  readonly tools: readonly ToolEntry[];
  readonly environment: ServerEnvironmentShape;
  readonly connections: Pick<
    HostConnectionRegistry,
    "list" | "get" | "call" | "lifecycleGeneration" | "connectionSignal"
  >;
  readonly requireThreadShell: (id: string) => Effect.Effect<OrchestrationThreadShell, unknown>;
}

export function makeRemoteAwareTools(input: RemoteGatewayDependencies): readonly ToolEntry[] {
  const discovery: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_list_connections",
      description:
        "Discover this computer and its paired execution connections. Use the returned environmentId on Synara project/thread tools. Lists connections owned by this server, not every device in the account. Does not connect or pair devices.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List Synara computers", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: () =>
      Effect.gen(function* () {
        const local = yield* input.environment.getDescriptor;
        return mcpToolResultJson({
          currentEnvironmentId: local.environmentId,
          remoteAvailable: local.capabilities.remoteConnections,
          computers: [
            {
              environmentId: local.environmentId,
              label: local.label,
              local: true,
              state: "connected",
            },
            ...(local.capabilities.remoteConnections
              ? input.connections.list().map((host) => ({
                  environmentId: host.environmentId,
                  hostId: host.hostId,
                  label: host.hostName,
                  local: false,
                  state: host.state ?? "connected",
                }))
              : []),
          ],
          guidance:
            "Omitting environmentId means this computer only. Read each computer separately; retain environmentId with every projectId/threadId. A missing remote chat is not proof it does not exist. Creation/wait batches and creation-plan limits apply per destination. Remote creation needs projectId; use wait/read instead of notifyCreatorOnComplete. Remote automation and computer/browser control are not delegated. Both servers must support remote agent tools.",
        });
      }),
  };
  return [
    discovery,
    ...input.tools.map(
      (tool): ToolEntry => ({
        ...tool,
        definition: REMOTE_TOOLS.has(tool.definition.name)
          ? {
              ...tool.definition,
              description: `${tool.definition.description} Optional environmentId selects a computer from synara_list_connections; omission stays on this computer.${tool.definition.name.startsWith("synara_create_thread") ? " Remote creation requires projectId; notifyCreatorOnComplete is unavailable remotely." : ""}`,
              inputSchema: {
                ...tool.definition.inputSchema,
                properties: {
                  ...(tool.definition.inputSchema.properties as object),
                  environmentId: {
                    type: "string",
                    description: "Computer environment ID returned by synara_list_connections.",
                  },
                },
              },
            }
          : tool.definition,
        handler: (args, context) =>
          Effect.gen(function* () {
            const local = yield* input.environment.getDescriptor;
            const targetId = readStringArg(args, "environmentId");
            const { environmentId: _target, ...localArgs } = args;
            if (targetId === undefined || targetId === local.environmentId) {
              const result = yield* tool.handler(localArgs, context);
              return REMOTE_TOOLS.has(tool.definition.name) ||
                tool.definition.name === "synara_context"
                ? qualifyGatewayResult(result, local.environmentId)
                : result;
            }
            if (!local.capabilities.remoteConnections || !REMOTE_TOOLS.has(tool.definition.name))
              return gatewayToolErrorResult(
                new GatewayToolError(
                  "capability_denied",
                  "This tool cannot target a remote computer.",
                ),
              );
            const connection = input.connections
              .list()
              .find((host) => host.environmentId === targetId);
            if (!connection?.executionScope || connection.executionScope.environmentId !== targetId)
              return gatewayToolErrorResult(
                new GatewayToolError(
                  "remote_unavailable",
                  "No verified connection to this computer. Connect it in Synara Settings first.",
                ),
              );
            if (tool.requiresActiveTurn) yield* context.assertCallerTurnActive();
            if (tool.requiredCapability === "thread:write")
              yield* input.assertRemoteWriteAllowed(context.callerThreadId);
            const caller = yield* input.requireThreadShell(context.callerThreadId);
            const generation = input.connections.lifecycleGeneration;
            const connectionSignal = input.connections.connectionSignal(connection.hostId);
            const scope = JSON.stringify(connection.executionScope);
            const assertCurrent = () =>
              Effect.gen(function* () {
                if (
                  !connectionSignal ||
                  connectionSignal.aborted ||
                  generation !== input.connections.lifecycleGeneration ||
                  JSON.stringify(input.connections.get(connection.hostId)?.executionScope) !== scope
                )
                  return yield* Effect.fail(
                    new GatewayToolError(
                      "remote_unavailable",
                      "Connection identity changed during the tool call.",
                    ),
                  );
                if (tool.requiresActiveTurn) yield* context.assertCallerTurnActive();
              });
            const call = Schema.decodeUnknownSync(RemoteAgentCall)({
              environmentId: EnvironmentId.makeUnsafe(connection.executionScope.environmentId),
              caller: {
                environmentId: local.environmentId,
                threadId: ThreadId.makeUnsafe(context.callerThreadId),
                turnId: context.callerTurnId ? TurnId.makeUnsafe(context.callerTurnId) : null,
                provider: context.callerProvider,
                runtimeMode: caller.runtimeMode,
                envMode: caller.envMode === "worktree" ? "worktree" : "local",
                capabilities: [...context.callerCapabilities].filter(
                  (capability) =>
                    capability === "thread:read" ||
                    capability === "thread:write" ||
                    capability === "diagnostics:read",
                ),
              },
              tool: tool.definition.name,
              arguments: localArgs,
            });
            yield* assertCurrent();
            const result = yield* Effect.raceFirst(
              Effect.tryPromise({
                try: (signal) =>
                  input.connections.call(
                    connection.hostId,
                    {
                      ...controllerProtocol,
                      requiredCapabilities: [
                        ...controllerProtocol.requiredCapabilities,
                        REMOTE_AGENT_GATEWAY_CAPABILITY,
                      ],
                    },
                    WS_METHODS.agentGatewayCall,
                    call,
                    signal,
                  ),
                catch: (error) => new GatewayToolError("remote_unavailable", errorText(error)),
              }),
              Effect.forever(Effect.sleep(100).pipe(Effect.andThen(assertCurrent()))),
            );
            yield* assertCurrent();
            const decoded = Schema.decodeUnknownSync(RemoteAgentResult)(result);
            return qualifyGatewayResult(
              {
                content: decoded.content,
                ...(decoded.isError !== undefined ? { isError: decoded.isError } : {}),
              },
              targetId,
            );
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed(
                gatewayToolErrorResult(
                  error instanceof GatewayToolError
                    ? error
                    : new GatewayToolError("operation_failed", errorText(error)),
                ),
              ),
            ),
            Effect.catchDefect((error) =>
              Effect.succeed(
                gatewayToolErrorResult(new GatewayToolError("operation_failed", errorText(error))),
              ),
            ),
          ),
      }),
    ),
  ];
}

/** Only the authenticated remote RPC handler may supply this context. No forwarding hop. */
export function receiveRemoteTool(input: {
  readonly call: RemoteAgentCall;
  readonly peerOwnerId: string;
  readonly environment: ServerEnvironmentShape;
  readonly tools: readonly ToolEntry[];
}): Effect.Effect<McpToolCallResult> {
  return Effect.gen(function* () {
    const local = yield* input.environment.getDescriptor;
    if (
      !local.capabilities.remoteConnections ||
      !input.peerOwnerId.startsWith("remote-device:") ||
      input.call.environmentId !== local.environmentId ||
      input.call.caller.environmentId === local.environmentId
    )
      return gatewayToolErrorResult(
        new GatewayToolError(
          "capability_denied",
          "An authenticated paired device targeting this environment is required.",
        ),
      );
    const tool = input.tools.find((entry) => entry.definition.name === input.call.tool);
    const caller = input.call.caller;
    if (
      !tool ||
      !REMOTE_TOOLS.has(input.call.tool) ||
      !caller.capabilities.some((value) => value === tool.requiredCapability)
    )
      return gatewayToolErrorResult(
        new GatewayToolError(
          "capability_denied",
          "This tool is not available for remote delegation.",
        ),
      );
    const args = input.call.arguments;
    if ("environmentId" in args)
      return gatewayToolErrorResult(
        new GatewayToolError("capability_denied", "Nested remote delegation is not supported."),
      );
    if (tool.requiresActiveTurn && caller.turnId === null)
      return gatewayToolErrorResult(
        new GatewayToolError(
          "caller_turn_inactive",
          "Remote writes require an active caller turn.",
        ),
      );
    if (input.call.tool.startsWith("synara_set_thread_") && !readStringArg(args, "threadId"))
      return gatewayToolErrorResult(
        new GatewayToolError("thread_not_found", "Remote mutations require an explicit threadId."),
      );
    const prompts = [
      args.prompt,
      args.message,
      ...(Array.isArray(args.threads) ? args.threads.map((entry) => entry?.prompt) : []),
    ];
    if (prompts.some((text) => typeof text === "string" && parseComputerInvocation(text)))
      return gatewayToolErrorResult(
        new GatewayToolError(
          "capability_denied",
          "Computer control is unavailable through remote delegation.",
        ),
      );
    // A stable peer + origin identity scopes durable replay keys without ever
    // pretending that the foreign caller is a local thread (even if IDs collide).
    const callerThreadId = `remote-agent:${stableGatewayDigest([input.peerOwnerId, caller.environmentId, caller.threadId], 64)}`;
    const deadline = Date.now() + 120_000;
    const assertActive = () =>
      Date.now() < deadline && caller.turnId !== null
        ? Effect.void
        : Effect.fail(new GatewayToolError("caller_turn_inactive", "Remote delegation expired."));
    return yield* tool.handler(args, {
      principal: {
        kind: "provider-session",
        sessionKey: callerThreadId,
        threadId: callerThreadId,
        provider: caller.provider,
        turnId: caller.turnId,
      },
      callerThreadId,
      callerThreadLabel: null,
      callerSessionKey: callerThreadId,
      callerProvider: caller.provider,
      callerCapabilities: new Set(caller.capabilities),
      callerTurnId: caller.turnId,
      assertCallerTurnActive: assertActive,
      jsonRpcRequestId: null,
      remoteCaller: { runtimeMode: caller.runtimeMode, envMode: caller.envMode },
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        gatewayToolErrorResult(new GatewayToolError("operation_failed", errorText(error))),
      ),
    ),
    Effect.catchDefect((error) =>
      Effect.succeed(
        gatewayToolErrorResult(new GatewayToolError("operation_failed", errorText(error))),
      ),
    ),
  );
}
