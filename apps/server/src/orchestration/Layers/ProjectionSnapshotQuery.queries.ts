// Purpose: SQL query builders for the orchestration projection snapshot read model.
// Layer: orchestration / persistence read path. Pure builders over a SqlClient.
// Exports: makeSnapshotQueries(sql), SnapshotQueries.
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
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

export const makeSnapshotQueries = (sql: SqlClient.SqlClient["Service"]) => {
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

  return {
    listProjectRows,
    listThreadRows,
    listThreadMessageRows,
    listThreadProposedPlanRows,
    listThreadActivityRows,
    listThreadSessionRows,
    listCheckpointRows,
    listLatestTurnRows,
    listProjectionStateRows,
    readProjectionCounts,
    getActiveProjectRowByWorkspaceRoot,
    getFirstActiveThreadIdByProject,
    getProjectRowById,
    getThreadRowById,
    getSyntheticSubagentParentThreadRow,
    listThreadMessageRowsByThread,
    listThreadProposedPlanRowsByThread,
    listThreadActivityRowsByThread,
    getThreadSessionRowByThread,
    getLatestTurnRowByThread,
    getThreadCheckpointContextThreadRow,
    listCheckpointRowsByThread,
    getFullThreadDiffContextRow,
  };
};

export type SnapshotQueries = ReturnType<typeof makeSnapshotQueries>;
