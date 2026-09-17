import { ProjectId, ProjectTaskId, ThreadId } from "@synara/contracts";
import { Effect } from "effect";

import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readBooleanArg, readStringArg } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

interface ProjectAgentToolDependencies {
  readonly projectAgent: ProjectAgentServiceShape;
}

export function makeProjectAgentTools(
  dependencies: ProjectAgentToolDependencies,
): ReadonlyArray<ToolEntry> {
  const { projectAgent } = dependencies;

  const resolvePrincipal = (threadId: string) =>
    projectAgent
      .resolvePrincipalForThread(ThreadId.makeUnsafe(threadId))
      .pipe(Effect.mapError((error) => new ToolInputError(error.message)));

  const getOverview: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_project_get_overview",
      description:
        "Read the current project's coordinator overview: goal, focus, blockers, and last summary. Does not include document bodies.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      annotations: { title: "Read project overview", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const overview = yield* projectAgent
          .getOverview(
            {
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(overview);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listTasks: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_project_list_tasks",
      description: "List project coordinator tasks, including review state and dependencies.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          includeArchived: { type: "boolean" },
        },
        required: ["projectId"],
      },
      annotations: { title: "List project tasks", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .listTasks(
            {
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              includeArchived: readBooleanArg(args, "includeArchived") ?? false,
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readDocument: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_project_read_document",
      description:
        "Read a shared project document by relative path. Additional documents are retrieved through this tool instead of being injected into context.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          logicalPath: { type: "string" },
        },
        required: ["projectId", "logicalPath"],
      },
      annotations: { title: "Read project document", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .readDocument(
            {
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              logicalPath: readStringArg(args, "logicalPath", { required: true })!,
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const writeDocument: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_project_write_document",
      description:
        "Write a shared project document with an expected revision. Workers may write inbox entries only. Conflicting edits return a conflict instead of overwriting.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          projectId: { type: "string" },
          logicalPath: { type: "string" },
          expectedRevision: { type: "number" },
          content: { type: "string" },
        },
        required: ["requestId", "projectId", "logicalPath", "content"],
      },
      annotations: { title: "Write project document", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .writeDocument(
            {
              requestId: readStringArg(args, "requestId", { required: true })!,
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              logicalPath: readStringArg(args, "logicalPath", { required: true })!,
              content: readStringArg(args, "content", { required: true })!,
              ...(typeof args.expectedRevision === "number"
                ? { expectedRevision: args.expectedRevision }
                : {}),
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const reportResult: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_project_report_result",
      description:
        "Report worker findings into the project inbox. This records evidence and moves the task to review. It does not mark the task done.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          projectId: { type: "string" },
          taskId: { type: "string" },
          summary: { type: "string" },
        },
        required: ["requestId", "projectId", "taskId", "summary"],
      },
      annotations: { title: "Report project task result", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .reportResult(
            {
              requestId: readStringArg(args, "requestId", { required: true })!,
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              taskId: ProjectTaskId.makeUnsafe(readStringArg(args, "taskId", { required: true })!),
              summary: readStringArg(args, "summary", { required: true })!,
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const contextPacket: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_project_context",
      description:
        "Load the bounded project context packet (goal, instructions, decisions, tasks) capped at 32,000 characters.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      annotations: { title: "Read project context packet", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const packet = yield* projectAgent
          .buildContextPacket(
            ProjectId.makeUnsafe(readStringArg(args, "projectId", { required: true })!),
            ThreadId.makeUnsafe(context.callerThreadId),
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(packet);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [getOverview, listTasks, readDocument, writeDocument, reportResult, contextPacket];
}
