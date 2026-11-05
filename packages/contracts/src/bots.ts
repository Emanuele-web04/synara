// FILE: bots.ts
// Purpose: Wire contracts for SynBot (Beta): bots, the main SynBot, delegations between bots,
//          interactive cards in bot threads, merge proof, and the `bots.*` stream.
// Layer: Contracts (schemas only, no runtime orchestration)
// Notes: A bot is a Hub (project kind "group") plus a bot profile. `Bot.id` is that Hub's
//        project id and `Bot.threadId` its coordinator thread. See docs/plans/synbot.md.

import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { HubWorkItem } from "./hubWork";
import { ModelSelection } from "./orchestration";
import { PullRequestMergeMethod } from "./pullRequests";

/** The id the main bot is always reachable by in tools and prompts. */
export const SYNBOT_MAIN_BOT_SLUG = "synbot";
export const SYNBOT_MAIN_BOT_NAME = "SynBot";

/** Orchestration caps (HoloBot defaults). Tunable later; enforced on the server. */
export const BOT_DELEGATION_MAX_DEPTH = 3;
export const BOT_DELEGATIONS_PER_TURN = 4;
export const BOT_ACTIVE_TASKS_PER_BOT = 1;
export const BOT_PARALLEL_TASKS_MIN = 1;
export const BOT_PARALLEL_TASKS_MAX = 8;
export const BOT_PARALLEL_TASKS_DEFAULT = 3;

export const BOT_NAME_MAX_LENGTH = 80;
export const BOT_ROLE_MAX_LENGTH = 120;
export const BOT_INSTRUCTIONS_MAX_LENGTH = 16_000;
export const BOT_BRIEF_MAX_LENGTH = 8_000;
export const BOT_SCOPE_PATHS_MAX = 32;
export const BOT_PINNED_SKILLS_MAX = 16;

// ── Bot record ───────────────────────────────────────────────────────

/** Mascot shapes ported from HoloBot; "synara" is reserved for the main SynBot. */
export const BOT_MASCOT_SHAPES = [
  "synara",
  "circle",
  "square",
  "pill",
  "triangle",
  "hexagon",
  "gem",
  "clover",
  "star",
  "drop",
] as const;
export const BotMascotShape = Schema.Literals(BOT_MASCOT_SHAPES);
export type BotMascotShape = typeof BotMascotShape.Type;

/** Mascot palette ported from HoloBot (`packages/ui/src/mascots.ts`). */
export const BOT_MASCOT_COLORS = [
  "#1a80fa",
  "#ff6b0d",
  "#2fb36b",
  "#8b5cf6",
  "#e5484d",
  "#14a3a3",
  "#d9a400",
  "#8e8e93",
] as const;
export const BotMascotColor = TrimmedNonEmptyString.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
export type BotMascotColor = typeof BotMascotColor.Type;

export const BotMascot = Schema.Struct({
  shape: BotMascotShape,
  color: BotMascotColor,
});
export type BotMascot = typeof BotMascot.Type;

export const BotKind = Schema.Literals(["main", "bot"]);
export type BotKind = typeof BotKind.Type;

/** `auto`: delegated work starts on its own. `ask`: a Start / Not now card waits for the user. */
export const BotAutonomy = Schema.Literals(["auto", "ask"]);
export type BotAutonomy = typeof BotAutonomy.Type;

/** A repository-relative glob such as `apps/web/**`. Guidance and warnings only, never a sandbox. */
export const BotPathGlob = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type BotPathGlob = typeof BotPathGlob.Type;

export const BotScope = Schema.Struct({
  projects: Schema.Union([Schema.Literal("all"), Schema.Array(ProjectId)]),
  paths: Schema.Array(BotPathGlob).check(Schema.isMaxLength(BOT_SCOPE_PATHS_MAX)),
});
export type BotScope = typeof BotScope.Type;

export const BotPinnedSkill = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type BotPinnedSkill = typeof BotPinnedSkill.Type;

/** Derived: waiting (needs the user) wins over working, which wins over idle. */
export const BotStatus = Schema.Literals(["idle", "working", "waiting", "paused"]);
export type BotStatus = typeof BotStatus.Type;

export const Bot = Schema.Struct({
  id: ProjectId,
  kind: BotKind,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_NAME_MAX_LENGTH)),
  role: Schema.String.check(Schema.isMaxLength(BOT_ROLE_MAX_LENGTH)),
  mascot: BotMascot,
  instructions: Schema.String.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_LENGTH)),
  scope: BotScope,
  /** The bot chat's engine. */
  modelSelection: ModelSelection,
  /** The engine its tasks start on; absent means the chat's. */
  taskModelSelection: Schema.optional(ModelSelection),
  autonomy: BotAutonomy,
  pinnedSkills: Schema.Array(BotPinnedSkill).check(Schema.isMaxLength(BOT_PINNED_SKILLS_MAX)),
  pinned: Schema.Boolean,
  threadId: ThreadId,
  status: BotStatus,
  /** Hub config revision; pass it back as `expectedRevision` to detect concurrent edits. */
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Bot = typeof Bot.Type;

/** A bot proposal or template: everything but identity and runtime state. */
export const BotDraft = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_NAME_MAX_LENGTH)),
  role: Schema.String.check(Schema.isMaxLength(BOT_ROLE_MAX_LENGTH)),
  mascot: Schema.optional(BotMascot),
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_LENGTH)),
  ),
  scope: BotScope,
});
export type BotDraft = typeof BotDraft.Type;

// ── Settings ─────────────────────────────────────────────────────────

/** `request`: one recap per request (default). `task`: one line per finished task. */
export const BotRecapMode = Schema.Literals(["request", "task"]);
export type BotRecapMode = typeof BotRecapMode.Type;

export const BotSettings = Schema.Struct({
  recapMode: BotRecapMode,
  /** Bots may write to and stop any chat without asking when the user started the turn. */
  controlWithoutAsking: Schema.Boolean,
  /** Shows the merge proof card and its Merge button. Off by default: merging is sensitive. */
  mergeProofEnabled: Schema.Boolean,
  maxParallelTasks: PositiveInt.check(
    Schema.isGreaterThanOrEqualTo(BOT_PARALLEL_TASKS_MIN),
    Schema.isLessThanOrEqualTo(BOT_PARALLEL_TASKS_MAX),
  ),
});
export type BotSettings = typeof BotSettings.Type;

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  recapMode: "request",
  controlWithoutAsking: true,
  mergeProofEnabled: false,
  maxParallelTasks: BOT_PARALLEL_TASKS_DEFAULT,
};

// ── Delegations ──────────────────────────────────────────────────────

/**
 * `awaiting-start`: the target bot asks before starting (autonomy "ask").
 * `sent` → `working` → `completed` | `failed` | `cancelled`. `waiting` means a task of the
 * delegation is waiting on the user.
 */
export const BotDelegationState = Schema.Literals([
  "awaiting-start",
  "sent",
  "working",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type BotDelegationState = typeof BotDelegationState.Type;

export const BOT_DELEGATION_TERMINAL_STATES: ReadonlySet<BotDelegationState> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const BotDelegation = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** Groups the delegations a single requester turn handed out (one recap per request). */
  requestId: TrimmedNonEmptyString,
  /** The first delegation of the chain; equals `id` at depth 1. */
  rootId: TrimmedNonEmptyString,
  depth: PositiveInt,
  fromBotId: ProjectId,
  fromThreadId: ThreadId,
  toBotId: ProjectId,
  toThreadId: ThreadId,
  brief: TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_BRIEF_MAX_LENGTH)),
  state: BotDelegationState,
  /** True when the chain started from a human message (it may drive other chats). */
  humanRooted: Schema.Boolean,
  resultSummary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  /** Worker tasks the target bot started for this delegation. */
  taskIds: Schema.Array(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
});
export type BotDelegation = typeof BotDelegation.Type;

// ── Cards (thread activities in bot threads) ─────────────────────────

/** Activity kinds bots append to their threads; clients render them as cards. */
export const BOT_CARD_ACTIVITY_KIND = "synbot.card";
export const BOT_CARD_RESOLVED_ACTIVITY_KIND = "synbot.card.resolved";
export const BOT_DELEGATION_ACTIVITY_KIND = "synbot.delegation";
export const BOT_REPORT_ACTIVITY_KIND = "synbot.report";
export const BOT_CONTROL_ACTIVITY_KIND = "synbot.control";

/** Message id prefixes of server-written messages in bot threads. */
export const BOT_DELEGATION_MESSAGE_PREFIX = "synbot:delegation:";
export const BOT_REPORT_MESSAGE_PREFIX = "synbot:report:";

export const BotCardKind = Schema.Literals([
  "bot-suggestions",
  "bot-proposal",
  "delegation-start",
  "git-init",
]);
export type BotCardKind = typeof BotCardKind.Type;

export const BotCardOption = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  tone: Schema.Literals(["primary", "normal", "danger", "dismiss"]),
});
export type BotCardOption = typeof BotCardOption.Type;

/** Payload of a `synbot.card` activity. */
export const BotCard = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: BotCardKind,
  botId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
  options: Schema.Array(BotCardOption).check(Schema.isMaxLength(8)),
  /** Bot drafts for suggestion and proposal cards, indexed by option id `create:<n>`. */
  drafts: Schema.optional(Schema.Array(BotDraft)),
  delegationId: Schema.optional(TrimmedNonEmptyString),
  projectPath: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type BotCard = typeof BotCard.Type;

/** Payload of a `synbot.card.resolved` activity. */
export const BotCardResolution = Schema.Struct({
  cardId: TrimmedNonEmptyString,
  optionId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  resolvedAt: IsoDateTime,
});
export type BotCardResolution = typeof BotCardResolution.Type;

/**
 * Payload of a `synbot.delegation` activity. Appended to the requester's thread ("→ Frontend is
 * on it") and to the target bot's thread ("Message from SynBot"); live state comes from the
 * `bots.*` stream by `delegationId`.
 */
export const BotDelegationNotice = Schema.Struct({
  delegationId: TrimmedNonEmptyString,
  fromBotId: ProjectId,
  toBotId: ProjectId,
  brief: TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_BRIEF_MAX_LENGTH)),
  createdAt: IsoDateTime,
});
export type BotDelegationNotice = typeof BotDelegationNotice.Type;

/**
 * Payload of a `synbot.report` activity in the requester's thread. The report itself is the
 * user-role message `messageId` (prefix `synbot:report:`) that wakes the requester; clients hide
 * that message and draw this card instead.
 */
/** A delegation as it stood when its report was sent; kept so old cards outlive the snapshot. */
export const BotReportEntry = Schema.Struct({
  delegationId: TrimmedNonEmptyString,
  toBotId: ProjectId,
  state: BotDelegationState,
  resultSummary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type BotReportEntry = typeof BotReportEntry.Type;

export const BotReportNotice = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  delegationIds: Schema.Array(TrimmedNonEmptyString),
  entries: Schema.optional(Schema.Array(BotReportEntry)),
  createdAt: IsoDateTime,
});
export type BotReportNotice = typeof BotReportNotice.Type;

/** Payload of a `synbot.control` activity: a bot wrote to or stopped this chat. */
export const BotControlNotice = Schema.Struct({
  botId: ProjectId,
  botName: TrimmedNonEmptyString,
  action: Schema.Literals(["message", "interrupt"]),
  createdAt: IsoDateTime,
});
export type BotControlNotice = typeof BotControlNotice.Type;

// ── Merge proof ──────────────────────────────────────────────────────

export const BotMergeRedFlag = Schema.Struct({
  kind: Schema.Literals([
    "test-removed",
    "test-skipped",
    "assertion-removed",
    "failure-ignored",
    "ci-step-removed",
  ]),
  file: TrimmedNonEmptyString,
  detail: Schema.String.check(Schema.isMaxLength(400)),
});
export type BotMergeRedFlag = typeof BotMergeRedFlag.Type;

export const BotMergeProof = Schema.Struct({
  threadId: ThreadId,
  prNumber: PositiveInt,
  prUrl: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  /** Required checks on the current head: all green, some pending, or some failed. */
  checks: Schema.Literals(["passing", "pending", "failing", "none"]),
  failingChecks: Schema.Array(TrimmedNonEmptyString),
  /** The PR is behind its base and needs an update before the proof is fresh. */
  behind: Schema.Boolean,
  conflicts: Schema.Boolean,
  redFlags: Schema.Array(BotMergeRedFlag),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  /** Merge is enabled only when this is true. */
  ready: Schema.Boolean,
  checkedAt: IsoDateTime,
});
export type BotMergeProof = typeof BotMergeProof.Type;

// ── RPC inputs and results ───────────────────────────────────────────

export const BotsSnapshot = Schema.Struct({
  bots: Schema.Array(Bot),
  settings: BotSettings,
  delegations: Schema.Array(BotDelegation),
  /** Non-terminal and recent tasks of every bot. */
  tasks: Schema.Array(
    Schema.Struct({
      botId: ProjectId,
      task: HubWorkItem,
    }),
  ),
});
export type BotsSnapshot = typeof BotsSnapshot.Type;

export const BotsListInput = Schema.Struct({});
export type BotsListInput = typeof BotsListInput.Type;

export const BotsEnsureMainInput = Schema.Struct({
  /** Engine for SynBot's chat when it is created; ignored afterwards. */
  modelSelection: Schema.optional(ModelSelection),
});
export type BotsEnsureMainInput = typeof BotsEnsureMainInput.Type;

export const BotsCreateInput = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_NAME_MAX_LENGTH)),
  role: Schema.String.check(Schema.isMaxLength(BOT_ROLE_MAX_LENGTH)),
  mascot: BotMascot,
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_LENGTH)),
  ),
  scope: BotScope,
  modelSelection: ModelSelection,
  taskModelSelection: Schema.optional(ModelSelection),
  autonomy: Schema.optional(BotAutonomy),
  pinnedSkills: Schema.optional(
    Schema.Array(BotPinnedSkill).check(Schema.isMaxLength(BOT_PINNED_SKILLS_MAX)),
  ),
  pinned: Schema.optional(Schema.Boolean),
});
export type BotsCreateInput = typeof BotsCreateInput.Type;

export const BotsUpdateInput = Schema.Struct({
  id: ProjectId,
  expectedRevision: Schema.optional(NonNegativeInt),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_NAME_MAX_LENGTH))),
  role: Schema.optional(Schema.String.check(Schema.isMaxLength(BOT_ROLE_MAX_LENGTH))),
  mascot: Schema.optional(BotMascot),
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_LENGTH)),
  ),
  scope: Schema.optional(BotScope),
  modelSelection: Schema.optional(ModelSelection),
  /** `null` clears it (tasks follow the chat's engine). */
  taskModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  autonomy: Schema.optional(BotAutonomy),
  pinnedSkills: Schema.optional(
    Schema.Array(BotPinnedSkill).check(Schema.isMaxLength(BOT_PINNED_SKILLS_MAX)),
  ),
  pinned: Schema.optional(Schema.Boolean),
});
export type BotsUpdateInput = typeof BotsUpdateInput.Type;

export const BotsRemoveInput = Schema.Struct({ id: ProjectId });
export type BotsRemoveInput = typeof BotsRemoveInput.Type;

export const BotsUpdateSettingsInput = Schema.Struct({
  recapMode: Schema.optional(BotRecapMode),
  controlWithoutAsking: Schema.optional(Schema.Boolean),
  mergeProofEnabled: Schema.optional(Schema.Boolean),
  maxParallelTasks: Schema.optional(BotSettings.fields.maxParallelTasks),
});
export type BotsUpdateSettingsInput = typeof BotsUpdateSettingsInput.Type;

export const BotsCardActionInput = Schema.Struct({
  threadId: ThreadId,
  cardId: TrimmedNonEmptyString,
  optionId: TrimmedNonEmptyString,
});
export type BotsCardActionInput = typeof BotsCardActionInput.Type;

export const BotsCardActionResult = Schema.Struct({
  cardId: TrimmedNonEmptyString,
  optionId: TrimmedNonEmptyString,
  /** Bots created by this answer, when the card created any. */
  createdBotIds: Schema.Array(ProjectId),
});
export type BotsCardActionResult = typeof BotsCardActionResult.Type;

export const BotsSuggestInput = Schema.Struct({ projectId: ProjectId });
export type BotsSuggestInput = typeof BotsSuggestInput.Type;

export const BotsSuggestResult = Schema.Struct({ drafts: Schema.Array(BotDraft) });
export type BotsSuggestResult = typeof BotsSuggestResult.Type;

export const BotsCancelDelegationInput = Schema.Struct({ delegationId: TrimmedNonEmptyString });
export type BotsCancelDelegationInput = typeof BotsCancelDelegationInput.Type;

export const BotsMergeProofInput = Schema.Struct({ threadId: ThreadId });
export type BotsMergeProofInput = typeof BotsMergeProofInput.Type;

export const BotsMergeInput = Schema.Struct({
  threadId: ThreadId,
  /** The head the user saw; a newer head refuses the merge and asks again. */
  headSha: TrimmedNonEmptyString,
  method: Schema.optional(PullRequestMergeMethod),
});
export type BotsMergeInput = typeof BotsMergeInput.Type;

export const BotsMergeResult = Schema.Struct({
  outcome: Schema.Literals(["merged", "enqueued", "refused"]),
  message: Schema.optional(Schema.String),
  proof: BotMergeProof,
});
export type BotsMergeResult = typeof BotsMergeResult.Type;

export const BotsUpdateBranchInput = Schema.Struct({ threadId: ThreadId });
export type BotsUpdateBranchInput = typeof BotsUpdateBranchInput.Type;

export const BotsStopAllResult = Schema.Struct({
  interruptedThreadIds: Schema.Array(ThreadId),
  cancelledTaskIds: Schema.Array(TrimmedNonEmptyString),
  cancelledDelegationIds: Schema.Array(TrimmedNonEmptyString),
});
export type BotsStopAllResult = typeof BotsStopAllResult.Type;

export const BotsSubscribeInput = Schema.Struct({});
export type BotsSubscribeInput = typeof BotsSubscribeInput.Type;

export const BotStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: BotsSnapshot }),
  Schema.Struct({ type: Schema.Literal("bot-upserted"), bot: Bot }),
  Schema.Struct({ type: Schema.Literal("bot-removed"), botId: ProjectId }),
  Schema.Struct({ type: Schema.Literal("settings-updated"), settings: BotSettings }),
  Schema.Struct({ type: Schema.Literal("delegation-upserted"), delegation: BotDelegation }),
  Schema.Struct({
    type: Schema.Literal("task-upserted"),
    botId: ProjectId,
    task: HubWorkItem,
  }),
]);
export type BotStreamEvent = typeof BotStreamEvent.Type;
