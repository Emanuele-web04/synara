// FILE: botTools.ts
// Purpose: SynBot's gateway tools for bot chats: the roster, delegation to another bot, delegation
//          status, bot proposals and suggestions, and adding a folder as a Synara project.
//          Advertised only to bot chats; every handler re-checks the caller.
// Layer: Agent gateway tools
// See: docs/plans/synbot.md

import {
  BOT_BRIEF_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_ROLE_MAX_LENGTH,
  BotDraft,
  ProjectId,
  ThreadId,
  type Bot,
} from "@synara/contracts";
import { Effect, Schema } from "effect";

import { describeBotScope } from "../bots/botPrompts.ts";
import type { BotCaller, BotServiceShape } from "../bots/Services/BotService.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readStringArg } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

const decodeDraft = Schema.decodeUnknownEffect(BotDraft);

const rosterEntry = (bot: Bot, self: Bot) => ({
  botId: bot.id,
  name: bot.name,
  kind: bot.kind,
  role: bot.role,
  scope: describeBotScope(bot.scope, []),
  status: bot.status,
  autonomy: bot.autonomy,
  you: bot.id === self.id,
});

export function makeBotTools(dependencies: { readonly bots: BotServiceShape }): ReadonlyArray<ToolEntry> {
  const { bots } = dependencies;

  const resolveCaller = (context: Pick<ToolContext, "callerThreadId" | "callerTurnId">) =>
    bots
      .resolveCaller({
        threadId: ThreadId.makeUnsafe(context.callerThreadId),
        turnId: context.callerTurnId,
      })
      .pipe(Effect.orElseSucceed(() => null));

  const requireCaller = (context: ToolContext) =>
    resolveCaller(context).pipe(
      Effect.flatMap((caller) =>
        caller
          ? Effect.succeed(caller)
          : Effect.fail(new ToolInputError("Only SynBot bot chats can use this tool.")),
      ),
    );

  const advertisedTo = (context: Omit<ToolContext, "jsonRpcRequestId">) =>
    resolveCaller(context).pipe(Effect.map((caller) => caller !== null));

  const run = (
    context: ToolContext,
    body: (caller: BotCaller) => Effect.Effect<unknown, unknown>,
  ) =>
    requireCaller(context).pipe(
      Effect.flatMap(body),
      Effect.map((value) => mcpToolResultJson(value)),
      Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
    );

  const list: ToolEntry = {
    requiredCapability: "thread:read",
    advertisedTo,
    definition: {
      name: "synara_bots_list",
      description:
        "List the SynBot bots: id, name, role, scope, status (idle/working/waiting/paused) and whether new work starts on its own. Use a botId with synara_bot_delegate.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List bots", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      run(context, (caller) =>
        bots.roster().pipe(Effect.map((roster) => ({ bots: roster.map((bot) => rosterEntry(bot, caller.bot)) }))),
      ),
  };

  const delegate: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    advertisedTo,
    definition: {
      name: "synara_bot_delegate",
      description:
        "Hand work to another bot. It receives your brief plus the user's original request, does the work in its own chat and tasks, and Synara reports the result back to you as a 'SynBot report' message: do not poll. Reuse the same requestId when retrying. At most 4 per turn; chains stop at 3 bots and never return to a bot already in the chain.",
      inputSchema: {
        type: "object",
        properties: {
          botId: { type: "string", description: "Target bot id from synara_bots_list." },
          brief: {
            type: "string",
            maxLength: BOT_BRIEF_MAX_LENGTH,
            description: "What to do and when it is done, in plain words.",
          },
          requestId: {
            type: "string",
            description: "Your idempotency key for this hand-off (for example a short slug).",
          },
        },
        required: ["botId", "brief", "requestId"],
        additionalProperties: false,
      },
      annotations: { title: "Delegate to a bot", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      run(context, (caller) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const botId = readStringArg(args, "botId", { required: true })!;
          const brief = readStringArg(args, "brief", { required: true })!;
          const requestId = readStringArg(args, "requestId", { required: true })!;
          if (!brief.trim()) return yield* Effect.fail(new ToolInputError("The brief is empty."));
          const delegation = yield* bots.delegate({
            caller,
            targetBotId: ProjectId.makeUnsafe(botId),
            brief,
            requestId,
          });
          return {
            delegationId: delegation.id,
            state: delegation.state,
            note:
              delegation.state === "awaiting-start"
                ? "This bot asks before starting: the user sees Start / Not now. Tell the user it waits for their Start."
                : "Sent. The result comes back as a SynBot report; tell the user in one line who is on it.",
          };
        }),
      ),
  };

  const delegations: ToolEntry = {
    requiredCapability: "thread:read",
    advertisedTo,
    definition: {
      name: "synara_bot_delegations",
      description:
        "Read the delegations you sent or received: state (sent, working, waiting, completed, failed, cancelled) and results. Only for answering the user; results arrive on their own.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Read delegations", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      run(context, (caller) => bots.listDelegationsFor(caller).pipe(Effect.map((items) => ({ delegations: items })))),
  };

  const propose: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    advertisedTo,
    definition: {
      name: "synara_bot_propose",
      description:
        "Offer the user a new bot (a card with Create / Not now). Use it only when similar work keeps coming back. The bot exists only after the user presses Create.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: BOT_NAME_MAX_LENGTH },
          role: { type: "string", maxLength: BOT_ROLE_MAX_LENGTH },
          instructions: { type: "string", maxLength: 4_000 },
          projectIds: {
            type: "array",
            items: { type: "string" },
            description: "Projects it works on; omit for every project.",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Optional repository-relative globs such as apps/web/**.",
          },
          reason: { type: "string", maxLength: 400, description: "One line on why." },
        },
        required: ["name", "role"],
        additionalProperties: false,
      },
      annotations: { title: "Propose a bot", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      run(context, (caller) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const projectIds = Array.isArray(args.projectIds)
            ? args.projectIds.filter((id): id is string => typeof id === "string")
            : null;
          const draft = yield* decodeDraft({
            name: args.name,
            role: args.role,
            ...(typeof args.instructions === "string" ? { instructions: args.instructions } : {}),
            scope: {
              projects: projectIds && projectIds.length > 0 ? projectIds : "all",
              paths: Array.isArray(args.paths) ? args.paths.filter((path) => typeof path === "string") : [],
            },
          }).pipe(Effect.mapError((error) => new ToolInputError(`Invalid bot: ${errorText(error)}`)));
          const reason = readStringArg(args, "reason");
          return yield* bots.propose({ caller, draft, ...(reason ? { reason } : {}) });
        }),
      ),
  };

  const suggest: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    advertisedTo,
    definition: {
      name: "synara_bot_suggest",
      description:
        "Scan a project's folders (no model call) and show the user a card suggesting 1-3 bots for it.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
        additionalProperties: false,
      },
      annotations: { title: "Suggest bots", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      run(context, (caller) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const projectId = ProjectId.makeUnsafe(readStringArg(args, "projectId", { required: true })!);
          const result = yield* bots.suggestForCaller({ caller, projectId });
          return { cardId: result.cardId, drafts: result.drafts.map((draft) => draft.name) };
        }),
      ),
  };

  const addProject: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    advertisedTo,
    definition: {
      name: "synara_bot_add_project",
      description:
        "Add a folder as a Synara project so tasks can run there. Existing projects are returned as they are. A folder that is not a Git repository shows the user a card to make it one first.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute folder path, or one starting with ~." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { title: "Add a project", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      run(context, (caller) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          return yield* bots.addProject({ caller, path: readStringArg(args, "path", { required: true })! });
        }),
      ),
  };

  return [list, delegate, delegations, propose, suggest, addProject];
}
