// FILE: BotRepository.ts (layer)
// Purpose: SQLite implementation of BotRepository over the migration 143 tables.
// Layer: Persistence layer

import {
  BotAutonomy,
  BotDelegationState,
  BotKind,
  BotMascot,
  BotPinnedSkill,
  BotScope,
  BotSettings,
  DEFAULT_BOT_SETTINGS,
  HubWorkSourceMessage,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BotRepository,
  BotRepositoryError,
  type BotDelegationRecord,
  type BotProfileRecord,
  type BotRepositoryShape,
} from "../Services/BotRepository";

const storageError = (cause: unknown) =>
  cause instanceof BotRepositoryError
    ? cause
    : new BotRepositoryError({ message: "Could not persist SynBot data.", code: "storage", cause });

const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

const decodeMascot = decodeJson(BotMascot);
const decodeScope = decodeJson(BotScope);
const decodeSkills = decodeJson(Schema.Array(BotPinnedSkill));
const decodeSources = decodeJson(Schema.Array(HubWorkSourceMessage));
const decodeChain = decodeJson(Schema.Array(ProjectId));
const decodeTaskIds = decodeJson(Schema.Array(Schema.String));
const decodeSettings = decodeJson(BotSettings);
const decodeKind = Schema.decodeUnknownEffect(BotKind);
const decodeAutonomy = Schema.decodeUnknownEffect(BotAutonomy);
const decodeState = Schema.decodeUnknownEffect(BotDelegationState);

interface ProfileRow {
  readonly projectId: string;
  readonly kind: string;
  readonly role: string;
  readonly mascotShape: string;
  readonly mascotColor: string;
  readonly scopeJson: string;
  readonly autonomy: string;
  readonly pinnedSkillsJson: string;
  readonly pinned: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DelegationRow {
  readonly delegationId: string;
  readonly requestId: string;
  readonly rootId: string;
  readonly depth: number;
  readonly chainJson: string;
  readonly fromProjectId: string;
  readonly fromThreadId: string;
  readonly fromTurnId: string | null;
  readonly toProjectId: string;
  readonly toThreadId: string;
  readonly messageId: string;
  readonly brief: string;
  readonly sourceMessagesJson: string;
  readonly humanRooted: number;
  readonly state: string;
  readonly resultSummary: string | null;
  readonly taskIdsJson: string;
  readonly reportedAt: string | null;
  readonly reportMessageId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly settledAt: string | null;
  readonly updatedAt: string;
}

const decodeProfile = (row: ProfileRow) =>
  Effect.gen(function* () {
    return {
      projectId: ProjectId.makeUnsafe(row.projectId),
      kind: yield* decodeKind(row.kind),
      role: row.role,
      mascot: yield* decodeMascot(
        JSON.stringify({ shape: row.mascotShape, color: row.mascotColor }),
      ),
      scope: yield* decodeScope(row.scopeJson),
      autonomy: yield* decodeAutonomy(row.autonomy),
      pinnedSkills: yield* decodeSkills(row.pinnedSkillsJson),
      pinned: row.pinned === 1,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies BotProfileRecord;
  });

const decodeDelegation = (row: DelegationRow) =>
  Effect.gen(function* () {
    return {
      id: row.delegationId,
      requestId: row.requestId,
      rootId: row.rootId,
      depth: row.depth,
      chain: yield* decodeChain(row.chainJson),
      fromBotId: ProjectId.makeUnsafe(row.fromProjectId),
      fromThreadId: ThreadId.makeUnsafe(row.fromThreadId),
      fromTurnId: row.fromTurnId,
      toBotId: ProjectId.makeUnsafe(row.toProjectId),
      toThreadId: ThreadId.makeUnsafe(row.toThreadId),
      messageId: row.messageId,
      brief: row.brief,
      sourceMessages: yield* decodeSources(row.sourceMessagesJson),
      humanRooted: row.humanRooted === 1,
      state: yield* decodeState(row.state),
      resultSummary: row.resultSummary,
      taskIds: yield* decodeTaskIds(row.taskIdsJson),
      reportedAt: row.reportedAt,
      reportMessageId: row.reportMessageId,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      settledAt: row.settledAt,
      updatedAt: row.updatedAt,
    } satisfies BotDelegationRecord;
  });

const first = <A>(rows: readonly A[]) => rows[0] ?? null;

export const makeBotRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const profileColumns = sql`
    project_id AS "projectId", kind, role, mascot_shape AS "mascotShape",
    mascot_color AS "mascotColor", scope_json AS "scopeJson", autonomy,
    pinned_skills_json AS "pinnedSkillsJson", pinned, revision, created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;
  const delegationColumns = sql`
    delegation_id AS "delegationId", request_id AS "requestId", root_id AS "rootId", depth,
    chain_json AS "chainJson", from_project_id AS "fromProjectId",
    from_thread_id AS "fromThreadId", from_turn_id AS "fromTurnId",
    to_project_id AS "toProjectId", to_thread_id AS "toThreadId", message_id AS "messageId",
    brief, source_messages_json AS "sourceMessagesJson", human_rooted AS "humanRooted", state,
    result_summary AS "resultSummary", task_ids_json AS "taskIdsJson",
    reported_at AS "reportedAt", report_message_id AS "reportMessageId", created_at AS "createdAt", started_at AS "startedAt",
    settled_at AS "settledAt", updated_at AS "updatedAt"
  `;
  const profiles = (rows: readonly ProfileRow[]) => Effect.forEach(rows, decodeProfile);
  const delegations = (rows: readonly DelegationRow[]) => Effect.forEach(rows, decodeDelegation);

  const writeDelegation = (record: BotDelegationRecord, mode: "insert" | "upsert") => {
    const values = sql`(
      ${record.id}, ${record.requestId}, ${record.rootId}, ${record.depth},
      ${JSON.stringify(record.chain)}, ${record.fromBotId}, ${record.fromThreadId},
      ${record.fromTurnId}, ${record.toBotId}, ${record.toThreadId}, ${record.messageId},
      ${record.brief}, ${JSON.stringify(record.sourceMessages)}, ${record.humanRooted ? 1 : 0},
      ${record.state}, ${record.resultSummary}, ${JSON.stringify(record.taskIds)},
      ${record.reportedAt}, ${record.reportMessageId}, ${record.createdAt}, ${record.startedAt},
      ${record.settledAt},
      ${record.updatedAt}
    )`;
    const columns = sql`(
      delegation_id, request_id, root_id, depth, chain_json, from_project_id, from_thread_id,
      from_turn_id, to_project_id, to_thread_id, message_id, brief, source_messages_json,
      human_rooted, state, result_summary, task_ids_json, reported_at, report_message_id,
      created_at, started_at,
      settled_at, updated_at
    )`;
    return mode === "insert"
      ? sql`INSERT INTO bot_delegations ${columns} VALUES ${values}
          ON CONFLICT (delegation_id) DO NOTHING`
      : sql`INSERT INTO bot_delegations ${columns} VALUES ${values}
          ON CONFLICT (delegation_id) DO UPDATE SET
            state = excluded.state, result_summary = excluded.result_summary,
            task_ids_json = excluded.task_ids_json, reported_at = excluded.reported_at,
            report_message_id = excluded.report_message_id,
            started_at = excluded.started_at, settled_at = excluded.settled_at,
            updated_at = excluded.updated_at`;
  };

  const repository: BotRepositoryShape = {
    getProfile: (projectId) =>
      sql<ProfileRow>`SELECT ${profileColumns} FROM bot_profiles WHERE project_id = ${projectId}`.pipe(
        Effect.flatMap(profiles),
        Effect.map(first),
        Effect.mapError(storageError),
      ),
    getMainProfile: () =>
      sql<ProfileRow>`SELECT ${profileColumns} FROM bot_profiles WHERE kind = 'main'`.pipe(
        Effect.flatMap(profiles),
        Effect.map(first),
        Effect.mapError(storageError),
      ),
    listProfiles: () =>
      sql<ProfileRow>`
        SELECT ${profileColumns} FROM bot_profiles
        ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END, created_at, project_id
      `.pipe(Effect.flatMap(profiles), Effect.mapError(storageError)),
    upsertProfile: (profile) =>
      sql`
        INSERT INTO bot_profiles (
          project_id, kind, role, mascot_shape, mascot_color, scope_json, autonomy,
          pinned_skills_json, pinned, revision, created_at, updated_at
        ) VALUES (
          ${profile.projectId}, ${profile.kind}, ${profile.role}, ${profile.mascot.shape},
          ${profile.mascot.color}, ${JSON.stringify(profile.scope)}, ${profile.autonomy},
          ${JSON.stringify(profile.pinnedSkills)}, ${profile.pinned ? 1 : 0}, ${profile.revision},
          ${profile.createdAt}, ${profile.updatedAt}
        )
        ON CONFLICT (project_id) DO UPDATE SET
          role = excluded.role, mascot_shape = excluded.mascot_shape,
          mascot_color = excluded.mascot_color, scope_json = excluded.scope_json,
          autonomy = excluded.autonomy, pinned_skills_json = excluded.pinned_skills_json,
          pinned = excluded.pinned, revision = excluded.revision,
          updated_at = excluded.updated_at
      `.pipe(Effect.asVoid, Effect.mapError(storageError)),
    deleteProfile: (projectId) =>
      sql`DELETE FROM bot_profiles WHERE project_id = ${projectId}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),

    insertDelegation: (record) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* repository.getDelegation(record.id);
            if (existing) return { record: existing, inserted: false };
            yield* writeDelegation(record, "insert");
            return { record, inserted: true };
          }),
        )
        .pipe(Effect.mapError(storageError)),
    saveDelegation: (record) =>
      writeDelegation(record, "upsert").pipe(Effect.asVoid, Effect.mapError(storageError)),
    getDelegation: (id) =>
      sql<DelegationRow>`
        SELECT ${delegationColumns} FROM bot_delegations WHERE delegation_id = ${id}
      `.pipe(Effect.flatMap(delegations), Effect.map(first), Effect.mapError(storageError)),
    getDelegationByMessage: (messageId) =>
      sql<DelegationRow>`
        SELECT ${delegationColumns} FROM bot_delegations WHERE message_id = ${messageId}
      `.pipe(Effect.flatMap(delegations), Effect.map(first), Effect.mapError(storageError)),
    listRecentDelegations: (limit) =>
      sql<DelegationRow>`
        SELECT ${delegationColumns} FROM bot_delegations
        WHERE settled_at IS NULL OR reported_at IS NULL
        UNION
        SELECT * FROM (
          SELECT ${delegationColumns} FROM bot_delegations
          WHERE settled_at IS NOT NULL
          ORDER BY settled_at DESC LIMIT ${limit}
        )
        ORDER BY "createdAt" DESC
      `.pipe(Effect.flatMap(delegations), Effect.mapError(storageError)),
    listActiveDelegations: () =>
      sql<DelegationRow>`
        SELECT ${delegationColumns} FROM bot_delegations
        WHERE settled_at IS NULL OR reported_at IS NULL
        ORDER BY created_at
      `.pipe(Effect.flatMap(delegations), Effect.mapError(storageError)),
    listDelegationsByRequesterTurn: (input) =>
      (input.fromTurnId === null
        ? sql<DelegationRow>`
            SELECT ${delegationColumns} FROM bot_delegations
            WHERE from_thread_id = ${input.fromThreadId} AND from_turn_id IS NULL
            ORDER BY created_at`
        : sql<DelegationRow>`
            SELECT ${delegationColumns} FROM bot_delegations
            WHERE from_thread_id = ${input.fromThreadId} AND from_turn_id = ${input.fromTurnId}
            ORDER BY created_at`
      ).pipe(Effect.flatMap(delegations), Effect.mapError(storageError)),
    listDelegationsByReportMessage: (messageId) =>
      sql<DelegationRow>`
        SELECT ${delegationColumns} FROM bot_delegations
        WHERE report_message_id = ${messageId} ORDER BY created_at
      `.pipe(Effect.flatMap(delegations), Effect.mapError(storageError)),
    listDelegationsByRequest: (requestId) =>
      sql<DelegationRow>`
        SELECT ${delegationColumns} FROM bot_delegations
        WHERE request_id = ${requestId} ORDER BY created_at
      `.pipe(Effect.flatMap(delegations), Effect.mapError(storageError)),
    deleteDelegationsForBot: (projectId) =>
      sql`
        DELETE FROM bot_delegations
        WHERE from_project_id = ${projectId} OR to_project_id = ${projectId}
      `.pipe(Effect.asVoid, Effect.mapError(storageError)),

    getSettings: () =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly settingsJson: string;
          readonly freshStartAt: string | null;
        }>`SELECT settings_json AS "settingsJson", fresh_start_at AS "freshStartAt"
           FROM bot_settings WHERE id = 1`;
        const row = rows[0];
        if (!row) return { settings: DEFAULT_BOT_SETTINGS, freshStartAt: null };
        // Unknown or damaged rows fall back to the defaults instead of breaking SynBot.
        const settings = yield* decodeSettings(row.settingsJson).pipe(
          Effect.orElseSucceed(() => DEFAULT_BOT_SETTINGS),
        );
        return { settings, freshStartAt: row.freshStartAt };
      }).pipe(Effect.mapError(storageError)),
    putSettings: (settings) =>
      sql`
        INSERT INTO bot_settings (id, settings_json, fresh_start_at, updated_at)
        VALUES (1, ${JSON.stringify(settings)}, NULL, ${new Date().toISOString()})
        ON CONFLICT (id) DO UPDATE SET
          settings_json = excluded.settings_json, updated_at = excluded.updated_at
      `.pipe(Effect.asVoid, Effect.mapError(storageError)),
    markFreshStart: (at) =>
      sql`
        INSERT INTO bot_settings (id, settings_json, fresh_start_at, updated_at)
        VALUES (1, ${JSON.stringify(DEFAULT_BOT_SETTINGS)}, ${at}, ${at})
        ON CONFLICT (id) DO UPDATE SET fresh_start_at = excluded.fresh_start_at
      `.pipe(Effect.asVoid, Effect.mapError(storageError)),
  };
  return repository;
});

export const BotRepositoryLive = Layer.effect(BotRepository, makeBotRepository);
