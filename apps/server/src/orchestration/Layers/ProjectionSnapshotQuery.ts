import type {
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadRuntime,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { ProjectionThreadRuntimeRepository } from "../../persistence/Services/ProjectionThreadRuntime.ts";
import { ProjectionThreadRuntimeRepositoryLive } from "../../persistence/Layers/ProjectionThreadRuntime.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionFullThreadDiffContext,
  type ProjectionSnapshotCounts,
  type ProjectionSnapshotSequence,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  decodeReadModel,
  decodeShellSnapshot,
  decodeThreadDetail,
  decodeThreadDetailSnapshot,
  FullThreadDiffContextLookupInput,
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_MESSAGES,
  ProjectIdLookupInput,
  ProjectionCheckpointDbRowSchema,
  ProjectionCountsRowSchema,
  ProjectionFullThreadDiffContextRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionProjectDbRowSchema,
  ProjectionProjectLookupRowSchema,
  ProjectionStateDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadCheckpointContextThreadRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadIdLookupRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  SyntheticSubagentParentLookupInput,
  ThreadIdLookupInput,
  WorkspaceRootLookupInput,
} from "./ProjectionSnapshotQuery.schemas.ts";
import {
  decodeProjectionProjectOption,
  decodeProjectionProjectRows,
  decodeProjectionThreadOption,
  decodeProjectionThreadRows,
  toPersistenceSqlOrDecodeError,
} from "./ProjectionSnapshotQuery.decode.ts";
import {
  computeSnapshotSequence,
  maxIso,
  toProjectedActivity,
  toProjectedCheckpoint,
  toProjectedLatestTurn,
  toProjectedMessage,
  toProjectedProjectShell,
  toProjectedProposedPlan,
  toProjectedSession,
  toProjectedThread,
  toProjectedThreadShellFromStoredSummary,
  toThreadRuntime,
} from "./ProjectionSnapshotQuery.mappers.ts";

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionThreadRuntimeRepository = yield* ProjectionThreadRuntimeRepository;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          parent_thread_id AS "parentThreadId",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          review_chat_target_json AS "reviewChatTarget",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          mentions_json AS "mentions",
          dispatch_mode AS "dispatchMode",
          is_streaming AS "isStreaming",
          source,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY created_at DESC, message_id DESC
            ) AS message_rank
          FROM projection_thread_messages
        )
        WHERE message_rank <= ${MAX_THREAD_MESSAGES}
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                activity_id DESC
            ) AS activity_rank
          FROM projection_thread_activities
        ) AS ranked
        WHERE activity_rank <= ${MAX_THREAD_ACTIVITIES}
          OR (
            kind IN ('approval.requested', 'user-input.requested')
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM projection_thread_activities AS later
              WHERE later.thread_id = ranked.thread_id
                AND json_extract(later.payload_json, '$.requestId') =
                  json_extract(ranked.payload_json, '$.requestId')
                AND (
                  (ranked.kind = 'approval.requested' AND later.kind = 'approval.resolved')
                  OR (
                    ranked.kind = 'approval.requested'
                    AND later.kind = 'provider.approval.respond.failed'
                    AND (
                      lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%stale pending approval request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending approval request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending permission request%'
                    )
                  )
                  OR (ranked.kind = 'user-input.requested' AND later.kind = 'user-input.resolved')
                  OR (
                    ranked.kind = 'user-input.requested'
                    AND later.kind = 'provider.user-input.respond.failed'
                    AND (
                      lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%stale pending user-input request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending user-input request%'
                    )
                  )
                )
                AND (
                  CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END >
                    CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                  OR (
                    CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    AND COALESCE(later.sequence, -1) > COALESCE(ranked.sequence, -1)
                  )
                  OR (
                    CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                    AND later.created_at > ranked.created_at
                  )
                  OR (
                    CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                    AND later.created_at = ranked.created_at
                    AND later.activity_id > ranked.activity_id
                  )
                )
            )
          )
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          COALESCE(completed_at, started_at, requested_at) AS "completedAt"
        FROM projection_turns
        -- Provider-diff placeholders can reserve checkpoint metadata before the
        -- turn is complete; snapshot checkpoint summaries require completedAt.
        WHERE checkpoint_turn_count IS NOT NULL
          AND completed_at IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  // Cheap targeted reads avoid hydrating the full snapshot for startup and diff lookups.
  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY CASE kind WHEN 'project' THEN 0 ELSE 1 END, created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          parent_thread_id AS "parentThreadId",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          review_chat_target_json AS "reviewChatTarget",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSyntheticSubagentParentThreadRow = SqlSchema.findOneOption({
    Request: SyntheticSubagentParentLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          parent_thread_id AS "parentThreadId",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          review_chat_target_json AS "reviewChatTarget",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE ${threadId} LIKE ('subagent:' || thread_id || ':%')
          AND deleted_at IS NULL
        ORDER BY length(thread_id) DESC, created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          mentions_json AS "mentions",
          dispatch_mode AS "dispatchMode",
          is_streaming AS "isStreaming",
          source,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY created_at DESC, message_id DESC
            ) AS message_rank
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
        )
        WHERE thread_id = ${threadId}
          AND message_rank <= ${MAX_THREAD_MESSAGES}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                activity_id DESC
            ) AS activity_rank
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
        ) AS ranked
        WHERE thread_id = ${threadId}
          AND (
            activity_rank <= ${MAX_THREAD_ACTIVITIES}
            OR (
              kind IN ('approval.requested', 'user-input.requested')
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM projection_thread_activities AS later
                WHERE later.thread_id = ranked.thread_id
                  AND json_extract(later.payload_json, '$.requestId') =
                    json_extract(ranked.payload_json, '$.requestId')
                  AND (
                    (ranked.kind = 'approval.requested' AND later.kind = 'approval.resolved')
                    OR (
                      ranked.kind = 'approval.requested'
                      AND later.kind = 'provider.approval.respond.failed'
                      AND (
                        lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%stale pending approval request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending approval request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending permission request%'
                      )
                    )
                    OR (ranked.kind = 'user-input.requested' AND later.kind = 'user-input.resolved')
                    OR (
                      ranked.kind = 'user-input.requested'
                      AND later.kind = 'provider.user-input.respond.failed'
                      AND (
                        lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%stale pending user-input request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending user-input request%'
                      )
                    )
                  )
                  AND (
                    CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END >
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    OR (
                      CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                      AND COALESCE(later.sequence, -1) > COALESCE(ranked.sequence, -1)
                    )
                    OR (
                      CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                      AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                      AND later.created_at > ranked.created_at
                    )
                    OR (
                      CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                      AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                      AND later.created_at = ranked.created_at
                      AND later.activity_id > ranked.activity_id
                    )
                  )
              )
            )
          )
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NOT NULL
        ORDER BY requested_at DESC, turn_id DESC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.env_mode AS "envMode",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          COALESCE(completed_at, started_at, requested_at) AS "completedAt"
        FROM projection_turns
        -- Keep incomplete provider-diff placeholders out of the public
        -- checkpoint summary contract, which requires completedAt.
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
          AND completed_at IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.env_mode AS "envMode",
          threads.worktree_path AS "worktreePath",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
              AND turns.completed_at IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
              AND turns.completed_at IS NOT NULL
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionProjectRows(
                  rows,
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeModelSelections",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionThreadRows(
                  rows,
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeModelSelections",
                ),
              ),
            ),
            listThreadMessageRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
                ),
              ),
            ),
            listThreadProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listCheckpointRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const runtimeRows = yield* projectionThreadRuntimeRepository.listReadModels();

          const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
          const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
          const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
          const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
          const sessionsByThread = new Map<string, OrchestrationSession>();
          const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
          const runtimeByThread = new Map<string, OrchestrationThreadRuntime>();

          for (const row of runtimeRows) {
            runtimeByThread.set(row.threadId, toThreadRuntime(row));
          }

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of threadRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }

          for (const row of messageRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadMessages = messagesByThread.get(row.threadId) ?? [];
            threadMessages.push(toProjectedMessage(row));
            messagesByThread.set(row.threadId, threadMessages);
          }

          for (const row of proposedPlanRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
            threadProposedPlans.push(toProjectedProposedPlan(row));
            proposedPlansByThread.set(row.threadId, threadProposedPlans);
          }

          for (const row of activityRows) {
            updatedAt = maxIso(updatedAt, row.createdAt);
            const threadActivities = activitiesByThread.get(row.threadId) ?? [];
            threadActivities.push(toProjectedActivity(row));
            activitiesByThread.set(row.threadId, threadActivities);
          }

          for (const row of checkpointRows) {
            updatedAt = maxIso(updatedAt, row.completedAt);
            const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
            threadCheckpoints.push(toProjectedCheckpoint(row));
            checkpointsByThread.set(row.threadId, threadCheckpoints);
          }

          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByThread.has(row.threadId)) {
              continue;
            }
            latestTurnByThread.set(row.threadId, toProjectedLatestTurn(row));
          }

          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByThread.set(row.threadId, toProjectedSession(row));
          }

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
            id: row.projectId,
            kind: row.kind,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          }));

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) =>
            toProjectedThread({
              threadRow: row,
              latestTurn: latestTurnByThread.get(row.threadId) ?? null,
              messages: messagesByThread.get(row.threadId) ?? [],
              proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
              activities: activitiesByThread.get(row.threadId) ?? [],
              checkpoints: checkpointsByThread.get(row.threadId) ?? [],
              session: sessionsByThread.get(row.threadId) ?? null,
              runtime: runtimeByThread.get(row.threadId) ?? null,
            }),
          );

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            threadRows,
            proposedPlanRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionProjectRows(
                  rows,
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeModelSelections",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionThreadRows(
                  rows,
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeModelSelections",
                ),
              ),
            ),
            listThreadProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
          const sessionsByThread = new Map<string, OrchestrationSession>();
          const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of threadRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of proposedPlanRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
            threadProposedPlans.push(toProjectedProposedPlan(row));
            proposedPlansByThread.set(row.threadId, threadProposedPlans);
          }
          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByThread.set(row.threadId, toProjectedSession(row));
          }
          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByThread.has(row.threadId)) {
              continue;
            }
            latestTurnByThread.set(row.threadId, toProjectedLatestTurn(row));
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
            id: row.projectId,
            kind: row.kind,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          }));

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) =>
            toProjectedThread({
              threadRow: row,
              latestTurn: latestTurnByThread.get(row.threadId) ?? null,
              messages: [],
              proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
              activities: [],
              checkpoints: [],
              session: sessionsByThread.get(row.threadId) ?? null,
              // The command read model is a lightweight decider input (no
              // messages/activities); runtime is hydrated at the read APIs.
              runtime: null,
            }),
          );

          return yield* decodeReadModel({
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          }).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:decodeReadModel",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [projectRows, threadRows, sessionRows, latestTurnRows, stateRows] =
            yield* Effect.all([
              listProjectRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionProjectRows(
                    rows,
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeModelSelections",
                  ),
                ),
              ),
              listThreadRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionThreadRows(
                    rows,
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeModelSelections",
                  ),
                ),
              ),
              listThreadSessionRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
                  ),
                ),
              ),
              listLatestTurnRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
                  ),
                ),
              ),
              listProjectionStateRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
                  ),
                ),
              ),
            ]);

          const runtimeRows = yield* projectionThreadRuntimeRepository.listReadModels();

          const sessionsByThread = new Map<string, OrchestrationSession>();
          const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
          const runtimeByThread = new Map<string, OrchestrationThreadRuntime>();

          for (const row of runtimeRows) {
            runtimeByThread.set(row.threadId, toThreadRuntime(row));
          }

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of threadRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByThread.has(row.threadId)) {
              continue;
            }
            latestTurnByThread.set(row.threadId, toProjectedLatestTurn(row));
          }
          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByThread.set(row.threadId, toProjectedSession(row));
          }

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects: projectRows
              .filter((row) => row.deletedAt === null)
              .map((row) => toProjectedProjectShell(row)),
            threads: threadRows
              .filter((row) => row.deletedAt === null)
              .map((row) =>
                toProjectedThreadShellFromStoredSummary({
                  threadRow: row,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  session: sessionsByThread.get(row.threadId) ?? null,
                  runtime: runtimeByThread.get(row.threadId) ?? null,
                }),
              ),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeShellSnapshot(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map(
        (stateRows): ProjectionSnapshotSequence => ({
          snapshotSequence: computeSnapshotSequence(stateRows),
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          decodeProjectionProjectOption(
            option,
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeModelSelection",
          ),
        ),
        Effect.map((option) =>
          Option.map(
            option,
            (row): OrchestrationProject => ({
              id: row.projectId,
              kind: row.kind,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              defaultModelSelection: row.defaultModelSelection,
              scripts: row.scripts,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            }),
          ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        decodeProjectionProjectOption(
          option,
          "ProjectionSnapshotQuery.getProjectShellById:decodeModelSelection",
        ),
      ),
      Effect.map((option) => Option.map(option, (row) => toProjectedProjectShell(row))),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        envMode: threadRow.value.envMode,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getFullThreadDiffContext: ProjectionSnapshotQueryShape["getFullThreadDiffContext"] = (
    threadId,
    toTurnCount,
  ) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        envMode: row.value.envMode,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const threadRow = yield* getThreadRowById({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
              ),
            ),
            Effect.flatMap((option) =>
              decodeProjectionThreadOption(
                option,
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeModelSelection",
              ),
            ),
          );
          if (Option.isNone(threadRow)) {
            return Option.none<OrchestrationThreadShell>();
          }

          const [latestTurnRow, sessionRow, runtimeRow] = yield* Effect.all([
            getLatestTurnRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
                ),
              ),
            ),
            getThreadSessionRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
                ),
              ),
            ),
            projectionThreadRuntimeRepository.getReadModelByThreadId({ threadId }),
          ]);

          return Option.some(
            toProjectedThreadShellFromStoredSummary({
              threadRow: threadRow.value,
              latestTurn: Option.match(latestTurnRow, {
                onNone: () => null,
                onSome: (row) => toProjectedLatestTurn(row),
              }),
              session: Option.match(sessionRow, {
                onNone: () => null,
                onSome: (row) => toProjectedSession(row),
              }),
              runtime: Option.match(runtimeRow, {
                onNone: () => null,
                onSome: (row) => toThreadRuntime(row),
              }),
            }),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadShellById:query")(error);
        }),
      );

  const findSyntheticSubagentParentThread: ProjectionSnapshotQueryShape["findSyntheticSubagentParentThread"] =
    (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const parentRow = yield* getSyntheticSubagentParentThreadRow({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:query",
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:decodeRow",
                ),
              ),
              Effect.flatMap((option) =>
                decodeProjectionThreadOption(
                  option,
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:decodeModelSelection",
                ),
              ),
            );
            if (Option.isNone(parentRow)) {
              return Option.none<OrchestrationThread>();
            }
            return yield* loadThreadDetail(parentRow.value.threadId);
          }),
        )
        .pipe(
          Effect.mapError((error) => {
            if (isPersistenceError(error)) {
              return error;
            }
            return toPersistenceSqlError(
              "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:query",
            )(error);
          }),
        );

  // Hydrate a full thread detail projection without opening its own transaction.
  const loadThreadDetail = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadRowById({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
            "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          decodeProjectionThreadOption(
            option,
            "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeModelSelection",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const [
        messageRows,
        proposedPlanRows,
        activityRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
        runtimeRow,
      ] = yield* Effect.all([
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
        projectionThreadRuntimeRepository.getReadModelByThreadId({ threadId }),
      ]);

      const thread = toProjectedThread({
        threadRow: threadRow.value,
        latestTurn: Option.match(latestTurnRow, {
          onNone: () => null,
          onSome: (row) => toProjectedLatestTurn(row),
        }),
        messages: messageRows.map((row) => toProjectedMessage(row)),
        proposedPlans: proposedPlanRows.map((row) => toProjectedProposedPlan(row)),
        activities: activityRows.map((row) => toProjectedActivity(row)),
        checkpoints: checkpointRows.map((row) => toProjectedCheckpoint(row)),
        session: Option.match(sessionRow, {
          onNone: () => null,
          onSome: (row) => toProjectedSession(row),
        }),
        runtime: Option.match(runtimeRow, {
          onNone: () => null,
          onSome: (row) => toThreadRuntime(row),
        }),
      });

      return yield* decodeThreadDetail(thread).pipe(
        Effect.map((decodedThread) => Option.some(decodedThread)),
        Effect.mapError(
          toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
        ),
      );
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    sql.withTransaction(loadThreadDetail(threadId)).pipe(
      Effect.mapError((error) => {
        if (isPersistenceError(error)) {
          return error;
        }
        return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailById:query")(error);
      }),
    );

  // Capture the projection cursor and thread detail in one transaction so the
  // snapshot fence cannot advance past the detail payload the client receives.
  const getThreadDetailSnapshotById: ProjectionSnapshotQueryShape["getThreadDetailSnapshotById"] = (
    threadId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [threadDetail, stateRows] = yield* Effect.all([
            loadThreadDetail(threadId),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);
          if (Option.isNone(threadDetail)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }

          return yield* decodeThreadDetailSnapshot({
            snapshotSequence: computeSnapshotSequence(stateRows),
            thread: threadDetail.value,
          }).pipe(
            Effect.map((snapshot) => Option.some(snapshot)),
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshotById:decodeSnapshot",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshotById:query")(
            error,
          );
        }),
      );

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getCounts,
    getSnapshotSequence,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    findSyntheticSubagentParentThread,
    getThreadDetailById,
    getThreadDetailSnapshotById,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
).pipe(Layer.provideMerge(ProjectionThreadRuntimeRepositoryLive));
