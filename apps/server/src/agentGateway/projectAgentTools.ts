import { randomUUID } from "node:crypto";

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
        "Read the current group's coordinator overview: goal, focus, blockers, last summary, and linked repositories. The coordinator may create threads in this group or any linked repository listed here and in the context packet. Does not include document bodies.",
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

  const remember: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_project_remember",
      description:
        "Save a note to the group's shared memory (memory/<date>-<slug>.md) and update the MEMORY.md index every group thread reads. Near-identical notes are deduplicated onto the existing memory file.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          projectId: { type: "string" },
          note: { type: "string" },
          title: { type: "string" },
        },
        required: ["projectId", "note"],
      },
      annotations: { title: "Remember group note", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .remember(
            {
              requestId: readStringArg(args, "requestId") ?? randomUUID(),
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              note: readStringArg(args, "note", { required: true })!,
              title: readStringArg(args, "title"),
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const forget: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_project_forget",
      description:
        "Remove a group memory note file (memory/<date>-<slug>.md) and its index line in MEMORY.md.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          projectId: { type: "string" },
          path: { type: "string" },
        },
        required: ["projectId", "path"],
      },
      annotations: { title: "Forget group note", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .forget(
            {
              requestId: readStringArg(args, "requestId") ?? randomUUID(),
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              path: readStringArg(args, "path", { required: true })!,
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const linkRepository: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_project_link_repository",
      description:
        "Coordinator only. Link an existing ordinary Synara project to this group, by linkedProjectId or by its workspacePath. New group threads can then be started in that repository. Unlinking stays a user action.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          projectId: { type: "string" },
          linkedProjectId: { type: "string" },
          workspacePath: { type: "string" },
        },
        required: ["projectId"],
      },
      annotations: { title: "Link repository to group", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const linkedProjectId = readStringArg(args, "linkedProjectId");
        const workspacePath = readStringArg(args, "workspacePath");
        if ((linkedProjectId === undefined) === (workspacePath === undefined)) {
          return yield* Effect.fail(
            new ToolInputError("Pass exactly one of linkedProjectId or workspacePath."),
          );
        }
        const result = yield* projectAgent
          .linkRepository(
            {
              requestId: readStringArg(args, "requestId") ?? randomUUID(),
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              ...(linkedProjectId !== undefined
                ? { linkedProjectId: ProjectId.makeUnsafe(linkedProjectId) }
                : {}),
              ...(workspacePath !== undefined ? { workspacePath } : {}),
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const libraryList: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_project_library_list",
      description:
        "List files in the group's Library (optionally under relativePath). Returns the library root path and entries.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string" },
        },
        required: ["projectId"],
      },
      annotations: { title: "List group library", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .libraryList(
            {
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              relativePath: readStringArg(args, "relativePath"),
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const libraryAdd: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_project_library_add",
      description:
        "Copy a file or folder from this thread's own workspace into the group's Library and commit it. sourcePath must resolve inside your workspace; destinationPath defaults to the source name at the library root.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          projectId: { type: "string" },
          sourcePath: { type: "string" },
          destinationPath: { type: "string" },
        },
        required: ["projectId", "sourcePath"],
      },
      annotations: { title: "Add file to group library", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .libraryAdd(
            {
              requestId: readStringArg(args, "requestId") ?? randomUUID(),
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
              sourcePath: readStringArg(args, "sourcePath", { required: true })!,
              destinationPath: readStringArg(args, "destinationPath"),
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listThreads: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_project_list_threads",
      description:
        "Coordinator only. List every group thread — in the group and in linked repositories — with its live state, PR link, last update time, and task id.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      annotations: { title: "List group threads", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const principal = yield* resolvePrincipal(context.callerThreadId);
        const result = yield* projectAgent
          .listGroupThreads(
            {
              projectId: ProjectId.makeUnsafe(
                readStringArg(args, "projectId", { required: true })!,
              ),
            },
            principal,
          )
          .pipe(Effect.mapError((error) => new ToolInputError(error.message)));
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [
    getOverview,
    listTasks,
    readDocument,
    writeDocument,
    reportResult,
    contextPacket,
    remember,
    forget,
    linkRepository,
    libraryList,
    libraryAdd,
    listThreads,
  ];
}
