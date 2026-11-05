// FILE: BotRepository.ts (service)
// Purpose: Storage contract for SynBot: bot profiles (one per bot Hub), delegations between bots,
//          and the SynBot settings row. Tables come from migration 143.
// Layer: Persistence service

import type {
  BotAutonomy,
  BotDelegationState,
  BotKind,
  BotMascot,
  BotPinnedSkill,
  BotScope,
  BotSettings,
  HubWorkSourceMessage,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Schema, ServiceMap } from "effect";

export class BotRepositoryError extends Schema.TaggedErrorClass<BotRepositoryError>()(
  "BotRepositoryError",
  {
    message: Schema.String,
    code: Schema.Literals(["storage", "conflict", "not-found"]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface BotProfileRecord {
  readonly projectId: ProjectId;
  readonly kind: BotKind;
  readonly role: string;
  readonly mascot: BotMascot;
  readonly scope: BotScope;
  readonly autonomy: BotAutonomy;
  readonly pinnedSkills: readonly BotPinnedSkill[];
  readonly pinned: boolean;
  /** Bumped on every profile edit; a bot's revision is its Hub config's plus this. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BotDelegationRecord {
  readonly id: string;
  readonly requestId: string;
  readonly rootId: string;
  readonly depth: number;
  /** Bot ids from the root requester to the target; a bot already here cannot be asked again. */
  readonly chain: readonly ProjectId[];
  readonly fromBotId: ProjectId;
  readonly fromThreadId: ThreadId;
  readonly fromTurnId: string | null;
  readonly toBotId: ProjectId;
  readonly toThreadId: ThreadId;
  /** The user-role message written into the target bot's thread. */
  readonly messageId: string;
  readonly brief: string;
  /** The original human messages that authorize the chain (server-resolved provenance). */
  readonly sourceMessages: readonly HubWorkSourceMessage[];
  readonly humanRooted: boolean;
  readonly state: BotDelegationState;
  readonly resultSummary: string | null;
  readonly taskIds: readonly string[];
  /** When the report reached the requester; null while it is still owed. */
  readonly reportedAt: string | null;
  /** The report message that delivered it to the requester (provenance of the report turn). */
  readonly reportMessageId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly settledAt: string | null;
  readonly updatedAt: string;
}

export interface BotSettingsRecord {
  readonly settings: BotSettings;
  /** When the one-time Beta fresh start paused the legacy Hubs; null until it ran. */
  readonly freshStartAt: string | null;
}

export interface BotRepositoryShape {
  readonly getProfile: (
    projectId: ProjectId,
  ) => Effect.Effect<BotProfileRecord | null, BotRepositoryError>;
  readonly getMainProfile: () => Effect.Effect<BotProfileRecord | null, BotRepositoryError>;
  readonly listProfiles: () => Effect.Effect<readonly BotProfileRecord[], BotRepositoryError>;
  readonly upsertProfile: (profile: BotProfileRecord) => Effect.Effect<void, BotRepositoryError>;
  readonly deleteProfile: (projectId: ProjectId) => Effect.Effect<void, BotRepositoryError>;

  /** Inserts once; a second insert of the same id returns the stored row with `inserted: false`. */
  readonly insertDelegation: (
    record: BotDelegationRecord,
  ) => Effect.Effect<
    { readonly record: BotDelegationRecord; readonly inserted: boolean },
    BotRepositoryError
  >;
  readonly saveDelegation: (record: BotDelegationRecord) => Effect.Effect<void, BotRepositoryError>;
  readonly getDelegation: (
    id: string,
  ) => Effect.Effect<BotDelegationRecord | null, BotRepositoryError>;
  readonly getDelegationByMessage: (
    messageId: string,
  ) => Effect.Effect<BotDelegationRecord | null, BotRepositoryError>;
  /** Open delegations plus the most recent settled ones (newest first), at most `limit`. */
  readonly listRecentDelegations: (
    limit: number,
  ) => Effect.Effect<readonly BotDelegationRecord[], BotRepositoryError>;
  /** Delegations that are not settled, or settled with a report still owed. */
  readonly listActiveDelegations: () => Effect.Effect<
    readonly BotDelegationRecord[],
    BotRepositoryError
  >;
  readonly listDelegationsByRequesterTurn: (input: {
    readonly fromThreadId: ThreadId;
    readonly fromTurnId: string | null;
  }) => Effect.Effect<readonly BotDelegationRecord[], BotRepositoryError>;
  readonly listDelegationsByReportMessage: (
    messageId: string,
  ) => Effect.Effect<readonly BotDelegationRecord[], BotRepositoryError>;
  readonly listDelegationsByRequest: (
    requestId: string,
  ) => Effect.Effect<readonly BotDelegationRecord[], BotRepositoryError>;
  readonly deleteDelegationsForBot: (
    projectId: ProjectId,
  ) => Effect.Effect<void, BotRepositoryError>;

  readonly getSettings: () => Effect.Effect<BotSettingsRecord, BotRepositoryError>;
  readonly putSettings: (settings: BotSettings) => Effect.Effect<void, BotRepositoryError>;
  readonly markFreshStart: (at: string) => Effect.Effect<void, BotRepositoryError>;
}

export class BotRepository extends ServiceMap.Service<BotRepository, BotRepositoryShape>()(
  "synara/persistence/Services/BotRepository",
) {}
