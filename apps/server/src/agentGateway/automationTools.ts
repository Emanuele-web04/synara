import {
  AutomationId,
  ProjectId,
  ThreadId,
  type AutomationDefinition,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect } from "effect";

import type { AutomationServiceShape } from "../automation/Services/AutomationService.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readNumberArg, readStringArg } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

const HEARTBEAT_DEFAULT_INTERVAL_MINUTES = 5;
const HEARTBEAT_DEFAULT_MAX_ITERATIONS = 50;

interface AutomationToolDependencies {
  readonly automationService: AutomationServiceShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
  readonly assertCallerMayDriveThread: (
    caller: OrchestrationThreadShell,
    target: OrchestrationThreadShell,
  ) => Effect.Effect<void, ToolInputError>;
}

export function makeAgentGatewayAutomationTools(
  dependencies: AutomationToolDependencies,
): ReadonlyArray<ToolEntry> {
  const { automationService, requireThreadShell, assertCallerMayDriveThread } = dependencies;

  const requireAutomationDefinition = (automationId: string) =>
    automationService.list({ includeArchived: true }).pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
      Effect.flatMap((result) => {
        const definition = result.definitions.find((entry) => entry.id === automationId);
        return definition
          ? Effect.succeed(definition)
          : Effect.fail(new ToolInputError(`Automation "${automationId}" was not found.`));
      }),
    );

  const assertCallerMayCancelAutomation = (
    caller: OrchestrationThreadShell,
    definition: AutomationDefinition,
  ) =>
    Effect.gen(function* () {
      if (definition.sourceThreadId === caller.id) return;
      if (definition.targetThreadId) {
        const target = yield* requireThreadShell(definition.targetThreadId);
        yield* assertCallerMayDriveThread(caller, target);
        return;
      }
      return yield* Effect.fail(
        new ToolInputError(
          `Automation "${definition.id}" was not created by your thread and has no target thread you can authorize against.`,
        ),
      );
    });

  const createAutomation: ToolEntry = {
    requiredCapability: "automation:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_automation",
      description:
        "Create a Synara heartbeat automation that wakes a thread on an interval (default: your own thread every 5 minutes). Use it for periodic monitoring instead of relying on memory; cancel it with synara_cancel_automation when done.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Automation name." },
          prompt: {
            type: "string",
            description:
              "Message sent to the target thread on each wake (e.g. 'Check your child threads and steer them if needed').",
          },
          everyMinutes: {
            type: "number",
            description: "Wake interval in minutes (default 5, min 1).",
          },
          targetThreadId: {
            type: "string",
            description: "Thread woken on each interval; defaults to your own thread.",
          },
          maxIterations: {
            type: "number",
            description: "Safety cap on total wakes before auto-disable (default 50).",
          },
        },
        required: ["name", "prompt"],
        additionalProperties: false,
      },
      annotations: { title: "Create a Synara automation", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const name = readStringArg(args, "name", { required: true })!;
        const prompt = readStringArg(args, "prompt", { required: true })!;
        const everyMinutes = Math.max(
          1,
          readNumberArg(args, "everyMinutes") ?? HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
        );
        const targetThreadId = readStringArg(args, "targetThreadId") ?? context.callerThreadId;
        const maxIterations = Math.max(
          1,
          Math.round(readNumberArg(args, "maxIterations") ?? HEARTBEAT_DEFAULT_MAX_ITERATIONS),
        );
        const target = yield* requireThreadShell(targetThreadId);
        if (target.id !== context.callerThreadId) {
          const caller = yield* requireThreadShell(context.callerThreadId);
          yield* assertCallerMayDriveThread(caller, target);
        }
        const worktreeMode =
          target.envMode === "worktree" ? ("worktree" as const) : ("local" as const);
        const acknowledgedRisks: Array<"full-access" | "local-checkout"> = [];
        if (target.runtimeMode === "full-access") acknowledgedRisks.push("full-access");
        if (worktreeMode === "local") acknowledgedRisks.push("local-checkout");
        const definition = yield* automationService
          .create({
            projectId: target.projectId,
            sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
            name,
            prompt,
            schedule: { type: "interval", everySeconds: Math.round(everyMinutes * 60) },
            modelSelection: target.modelSelection,
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            mode: "heartbeat",
            targetThreadId: target.id,
            maxIterations,
            stopOnError: true,
            worktreeMode,
            acknowledgedRisks,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({
          automationId: definition.id,
          name: definition.name,
          targetThreadId: definition.targetThreadId,
          everyMinutes,
          nextRunAt: definition.nextRunAt,
          maxIterations: definition.maxIterations,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listAutomations: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_list_automations",
      description:
        "List Synara automations (id, name, schedule, target thread, enabled, next run).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Only automations of this project." },
        },
        additionalProperties: false,
      },
      annotations: { title: "List Synara automations", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const projectIdArg = readStringArg(args, "projectId");
        const result = yield* automationService
          .list(projectIdArg ? { projectId: ProjectId.makeUnsafe(projectIdArg) } : undefined)
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({
          automations: result.definitions.map((definition) => ({
            automationId: definition.id,
            name: definition.name,
            mode: definition.mode,
            schedule: definition.schedule,
            enabled: definition.enabled,
            targetThreadId: definition.targetThreadId,
            nextRunAt: definition.nextRunAt,
            iterationCount: definition.iterationCount,
            maxIterations: definition.maxIterations,
          })),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const cancelAutomation: ToolEntry = {
    requiredCapability: "automation:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_cancel_automation",
      description:
        'Stop a Synara automation. mode "disable" (default) pauses it and keeps history; "delete" archives it.',
      inputSchema: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation to stop." },
          mode: { type: "string", enum: ["disable", "delete"], description: "Stop mode." },
        },
        required: ["automationId"],
        additionalProperties: false,
      },
      annotations: { title: "Stop a Synara automation", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const automationId = readStringArg(args, "automationId", { required: true })!;
        const modeArg = readStringArg(args, "mode") ?? "disable";
        if (modeArg !== "disable" && modeArg !== "delete") {
          throw new ToolInputError(`Argument "mode" must be "disable" or "delete".`);
        }
        const id = AutomationId.makeUnsafe(automationId);
        const caller = yield* requireThreadShell(context.callerThreadId);
        const definition = yield* requireAutomationDefinition(automationId);
        yield* assertCallerMayCancelAutomation(caller, definition);
        if (modeArg === "delete") {
          yield* automationService
            .delete({ id })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        } else {
          yield* automationService
            .update({ id, enabled: false })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        }
        return mcpToolResultJson({ automationId, stopped: true, mode: modeArg });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [createAutomation, listAutomations, cancelAutomation];
}
