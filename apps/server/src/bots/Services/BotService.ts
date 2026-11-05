// FILE: BotService.ts (service)
// Purpose: SynBot's server API: bots (Hubs with a bot profile), the main SynBot, settings,
//          delegations between bots with provenance and settlement, cards, merge proof and the
//          global Stop. Built on ProjectAgentService (the Hub engine).
// Layer: Server domain service
// See: docs/plans/synbot.md

import type {
  Bot,
  BotDelegation,
  BotDraft,
  BotMergeProof,
  BotSettings,
  BotStreamEvent,
  BotsCancelDelegationInput,
  BotsCardActionInput,
  BotsCardActionResult,
  BotsCreateInput,
  BotsEnsureMainInput,
  BotsMergeInput,
  BotsMergeProofInput,
  BotsMergeResult,
  BotsRemoveInput,
  BotsSnapshot,
  BotsStopAllResult,
  BotsSuggestInput,
  BotsSuggestResult,
  BotsUpdateBranchInput,
  BotsUpdateInput,
  BotsUpdateSettingsInput,
  HubWorkSourceMessage,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Schema, ServiceMap, Stream } from "effect";

export class BotServiceError extends Schema.TaggedErrorClass<BotServiceError>()(
  "BotServiceError",
  {
    message: Schema.String,
    code: Schema.Literals([
      "forbidden",
      "invalid",
      "not-found",
      "conflict",
      "limit",
      "unavailable",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** A bot chat calling a SynBot tool, resolved from its thread. */
export interface BotCaller {
  readonly bot: Bot;
  /** The caller's running turn, when it has one. */
  readonly turnId: string | null;
  /** The delegation this turn works on, when another bot asked for it. */
  readonly delegationId: string | null;
  /** Bot ids from the root requester to the caller (the caller last). */
  readonly chain: readonly ProjectId[];
  readonly depth: number;
  /** The turn traces back to a human message (directly, or through every delegation). */
  readonly humanRooted: boolean;
  /** Human messages that authorize work started from this turn. */
  readonly sourceMessages: readonly HubWorkSourceMessage[];
}

export interface BotServiceShape {
  // ── Client API (user principal) ──────────────────────────────────
  readonly snapshot: () => Effect.Effect<BotsSnapshot, BotServiceError>;
  readonly ensureMain: (input: BotsEnsureMainInput) => Effect.Effect<Bot, BotServiceError>;
  readonly create: (input: BotsCreateInput) => Effect.Effect<Bot, BotServiceError>;
  readonly update: (input: BotsUpdateInput) => Effect.Effect<Bot, BotServiceError>;
  readonly remove: (input: BotsRemoveInput) => Effect.Effect<void, BotServiceError>;
  readonly updateSettings: (
    input: BotsUpdateSettingsInput,
  ) => Effect.Effect<BotSettings, BotServiceError>;
  readonly cardAction: (
    input: BotsCardActionInput,
  ) => Effect.Effect<BotsCardActionResult, BotServiceError>;
  readonly suggest: (input: BotsSuggestInput) => Effect.Effect<BotsSuggestResult, BotServiceError>;
  readonly cancelDelegation: (
    input: BotsCancelDelegationInput,
  ) => Effect.Effect<BotDelegation, BotServiceError>;
  readonly mergeProof: (input: BotsMergeProofInput) => Effect.Effect<BotMergeProof, BotServiceError>;
  readonly merge: (input: BotsMergeInput) => Effect.Effect<BotsMergeResult, BotServiceError>;
  readonly updateBranch: (
    input: BotsUpdateBranchInput,
  ) => Effect.Effect<BotMergeProof, BotServiceError>;
  readonly stopAll: () => Effect.Effect<BotsStopAllResult, BotServiceError>;
  readonly streamEvents: () => Stream.Stream<BotStreamEvent, BotServiceError>;

  // ── Gateway API (bot chats) ──────────────────────────────────────
  /** The bot whose chat is `threadId`, with its turn's delegation context; null otherwise. */
  readonly resolveCaller: (input: {
    readonly threadId: ThreadId;
    readonly turnId: string | null;
  }) => Effect.Effect<BotCaller | null, BotServiceError>;
  /** The `<synbot_bot>` section prefixed to a bot chat's turn; empty for any other thread. */
  readonly formatContextForTurn: (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
  }) => Effect.Effect<string, never>;
  readonly roster: () => Effect.Effect<readonly Bot[], BotServiceError>;
  readonly delegate: (input: {
    readonly caller: BotCaller;
    readonly targetBotId: ProjectId;
    readonly brief: string;
    readonly requestId: string;
  }) => Effect.Effect<BotDelegation, BotServiceError>;
  readonly listDelegationsFor: (
    caller: BotCaller,
  ) => Effect.Effect<readonly BotDelegation[], BotServiceError>;
  readonly propose: (input: {
    readonly caller: BotCaller;
    readonly draft: BotDraft;
    readonly reason?: string;
  }) => Effect.Effect<{ readonly cardId: string }, BotServiceError>;
  readonly suggestForCaller: (input: {
    readonly caller: BotCaller;
    readonly projectId: ProjectId;
  }) => Effect.Effect<{ readonly cardId: string; readonly drafts: readonly BotDraft[] }, BotServiceError>;
  readonly addProject: (input: {
    readonly caller: BotCaller;
    readonly path: string;
  }) => Effect.Effect<
    | { readonly status: "added" | "exists"; readonly projectId: ProjectId }
    | { readonly status: "needs-git"; readonly cardId: string },
    BotServiceError
  >;
  /**
   * Whether `callerThreadId` may write to or stop `targetThreadId` without the usual privilege
   * and ownership checks: the caller is a bot, the user allows it in Settings, and the caller's
   * running turn traces back to a human message. Returns the bot to label the action with.
   */
  readonly fullControlFor: (input: {
    readonly callerThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
  }) => Effect.Effect<{ readonly botId: ProjectId; readonly botName: string } | null, BotServiceError>;
  /**
   * Labels `targetThreadId` with "From <bot>" when a bot chat wrote to or stopped a chat that is
   * not its own task, so the user sees who acted there.
   */
  readonly noteControl: (input: {
    readonly callerThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly action: "message" | "interrupt";
  }) => Effect.Effect<void, never>;
  /** The human sources behind a delegation message (provenance for Hub work), else null. */
  readonly delegatedSources: (
    messageId: string,
  ) => Effect.Effect<readonly HubWorkSourceMessage[] | null, BotServiceError>;
  /** Whether `projectId` is a bot's Hub (used to apply bot task defaults). */
  readonly isBotProject: (projectId: ProjectId) => Effect.Effect<boolean, never>;

  // ── Reactor API ──────────────────────────────────────────────────
  readonly evaluateDelegations: (reason: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<void, never>;
  readonly onProjectCreated: (projectId: ProjectId) => Effect.Effect<void, never>;
  /** Republishes the bot whose chat is `threadId` when its derived status changed. */
  readonly refreshThread: (threadId: ThreadId) => Effect.Effect<void, never>;
  readonly freshStart: () => Effect.Effect<void, never>;
}

export class BotService extends ServiceMap.Service<BotService, BotServiceShape>()(
  "synara/bots/Services/BotService",
) {}
