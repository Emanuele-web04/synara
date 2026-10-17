import { Schema } from "effect";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas";

export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_TODO_PREFIX = "notion:";
export const NotionId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i),
);
export const NotionConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const NotionObject = Schema.Record(Schema.String, Schema.Unknown);
export type NotionObject = typeof NotionObject.Type;
export const NotionConnection = Schema.Struct({
  id: NotionConnectionId,
  workspaceId: NotionId,
  workspaceName: Schema.String,
  status: Schema.Literals(["connected", "needs-auth", "disconnect-pending"]),
  createdAt: IsoDateTime,
});
export type NotionConnection = typeof NotionConnection.Type;
export const NotionField = Schema.Literals([
  "title",
  "description",
  "status",
  "priority",
  "assignee",
  "due",
  "start",
  "project",
  "sprint",
  "epic",
  "milestone",
  "dependencies",
  "subtasks",
  "points",
]);
export type NotionField = typeof NotionField.Type;
export const NotionPropertyRef = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  type: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type NotionPropertyRef = typeof NotionPropertyRef.Type;
const OptionalProperty = Schema.optional(NotionPropertyRef);
export const NotionFieldMap = Schema.Struct({
  title: NotionPropertyRef,
  description: OptionalProperty,
  status: OptionalProperty,
  priority: OptionalProperty,
  assignee: OptionalProperty,
  due: OptionalProperty,
  start: OptionalProperty,
  project: OptionalProperty,
  sprint: OptionalProperty,
  epic: OptionalProperty,
  milestone: OptionalProperty,
  dependencies: OptionalProperty,
  subtasks: OptionalProperty,
  points: OptionalProperty,
});
export type NotionFieldMap = typeof NotionFieldMap.Type;
export const NotionSprintPlan = Schema.Struct({
  dataSourceId: NotionId,
  title: NotionPropertyRef,
  start: Schema.NullOr(NotionPropertyRef),
  end: Schema.NullOr(NotionPropertyRef),
  status: Schema.NullOr(NotionPropertyRef),
  completedStatusIds: Schema.Array(Schema.String),
});
export type NotionSprintPlan = typeof NotionSprintPlan.Type;
export const NotionMapping = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  connectionId: NotionConnectionId,
  dataSourceId: NotionId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** Local delegation context, not the record's Notion project property. */
  projectId: Schema.NullOr(ProjectId),
  fields: NotionFieldMap,
  sprintPlan: Schema.optional(Schema.NullOr(NotionSprintPlan)),
  completedStatusIds: Schema.Array(Schema.String),
  reopenedStatusId: Schema.NullOr(Schema.String),
  priorityOptions: Schema.Record(
    Schema.String,
    Schema.Literals(["none", "low", "medium", "high", "urgent"]),
  ),
  /** Connecting a workspace alone never grants an agent access. */
  agentAccess: Schema.Literals(["none", "read", "write"]),
  agentPageIds: Schema.optional(Schema.Array(NotionId).check(Schema.isMaxLength(20))),
  enabled: Schema.Boolean,
});
export type NotionMapping = typeof NotionMapping.Type;
export const NotionSyncState = Schema.Literals([
  "synced",
  "pending",
  "conflict",
  "unknown",
  "error",
]);
export type NotionSyncState = typeof NotionSyncState.Type;
export const NotionTodoReference = Schema.Struct({
  provider: Schema.Literal("notion"),
  connectionId: NotionConnectionId,
  mappingId: Schema.String,
  dataSourceId: NotionId,
  pageId: NotionId,
  url: Schema.String,
  workspaceName: Schema.String,
  status: Schema.NullOr(Schema.String),
  statusId: Schema.NullOr(Schema.String),
  assignees: Schema.Array(Schema.String),
  assigneeIds: Schema.Array(Schema.String),
  sprintIds: Schema.Array(Schema.String),
  epicIds: Schema.Array(Schema.String),
  milestoneIds: Schema.Array(Schema.String),
  dependencyIds: Schema.Array(Schema.String),
  subtaskIds: Schema.Array(Schema.String),
  startDate: Schema.NullOr(Schema.String),
  storyPoints: Schema.NullOr(Schema.Number),
  syncState: NotionSyncState,
  syncMessage: Schema.NullOr(Schema.String),
  writableFields: Schema.Array(
    Schema.Literals(["title", "notes", "priority", "dueDate", "completed"]),
  ),
});
export type NotionTodoReference = typeof NotionTodoReference.Type;
export const NotionReadInput = Schema.Struct({
  connectionId: NotionConnectionId,
  kind: Schema.Literals([
    "search",
    "page",
    "block",
    "children",
    "dataSource",
    "database",
    "query",
    "comments",
    "users",
    "property",
    "views",
  ]),
  id: Schema.optional(NotionId),
  propertyId: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  pageSize: Schema.optional(Schema.Literals([10, 20, 25, 50, 100])),
  filter: Schema.optional(NotionObject),
  sorts: Schema.optional(Schema.Array(NotionObject).check(Schema.isMaxLength(10))),
});
export type NotionReadInput = typeof NotionReadInput.Type;
export const NotionReadResult = Schema.Struct({ data: NotionObject });
export type NotionReadResult = typeof NotionReadResult.Type;
export const NotionWriteInput = Schema.Struct({
  requestId: NotionId,
  createdAt: IsoDateTime,
  connectionId: NotionConnectionId,
  kind: Schema.Literals([
    "updatePage",
    "createPage",
    "archivePage",
    "updateBlock",
    "appendBlocks",
    "comment",
  ]),
  id: NotionId,
  base: NotionObject,
  changes: NotionObject,
});
export type NotionWriteInput = typeof NotionWriteInput.Type;
export const NotionChange = Schema.Struct({
  id: Schema.String,
  connectionId: NotionConnectionId,
  resourceId: NotionId,
  kind: Schema.String,
  state: NotionSyncState,
  message: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  base: NotionObject,
  changes: NotionObject,
  remote: Schema.NullOr(NotionObject),
});
export type NotionChange = typeof NotionChange.Type;
export const NotionWriteResult = Schema.Struct({
  change: NotionChange,
  data: Schema.NullOr(NotionObject),
});
export type NotionWriteResult = typeof NotionWriteResult.Type;
export const NotionState = Schema.Struct({
  configured: Schema.Boolean,
  connections: Schema.Array(NotionConnection),
  mappings: Schema.Array(NotionMapping),
  changes: Schema.Array(NotionChange),
  syncing: Schema.Boolean,
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  syncError: Schema.NullOr(Schema.String),
});
export type NotionState = typeof NotionState.Type;
export const NotionConnectResult = Schema.Struct({
  transactionId: Schema.String,
  authorizationUrl: Schema.String,
  expiresAt: IsoDateTime,
});
export type NotionConnectResult = typeof NotionConnectResult.Type;
export const NotionCompleteInput = Schema.Struct({ transactionId: Schema.String });
export const NotionCompleteResult = Schema.Struct({
  pending: Schema.Boolean,
  connection: Schema.NullOr(NotionConnection),
});
export type NotionCompleteResult = typeof NotionCompleteResult.Type;
export const NotionDisconnectInput = Schema.Struct({ connectionId: NotionConnectionId });
export const NotionMappingDeleteInput = Schema.Struct({ mappingId: Schema.String });
export const NotionResolveInput = Schema.Struct({
  changeId: Schema.String,
  resolution: Schema.Literals(["remote", "retry"]),
});
export type NotionResolveInput = typeof NotionResolveInput.Type;
export const NotionOk = Schema.Struct({ ok: Schema.Boolean });
export const NOTION_WS_METHODS = {
  state: "notion.state",
  connect: "notion.connect",
  complete: "notion.complete",
  disconnect: "notion.disconnect",
  read: "notion.read",
  write: "notion.write",
  saveMapping: "notion.saveMapping",
  deleteMapping: "notion.deleteMapping",
  sync: "notion.sync",
  resolve: "notion.resolve",
} as const;
export interface NotionApi {
  state: () => Promise<NotionState>;
  connect: () => Promise<NotionConnectResult>;
  complete: (input: typeof NotionCompleteInput.Type) => Promise<NotionCompleteResult>;
  disconnect: (input: typeof NotionDisconnectInput.Type) => Promise<typeof NotionOk.Type>;
  read: (input: NotionReadInput) => Promise<NotionReadResult>;
  write: (input: NotionWriteInput) => Promise<NotionWriteResult>;
  saveMapping: (input: NotionMapping) => Promise<typeof NotionOk.Type>;
  deleteMapping: (input: typeof NotionMappingDeleteInput.Type) => Promise<typeof NotionOk.Type>;
  sync: () => Promise<NotionState>;
  resolve: (input: NotionResolveInput) => Promise<typeof NotionOk.Type>;
}
