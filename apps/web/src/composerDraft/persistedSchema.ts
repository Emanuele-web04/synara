// FILE: composerDraft/persistedSchema.ts
// Purpose: Effect schemas, derived types, and constants for the persisted composer-draft store shape.
// Layer: Web state store (schema definitions)
// Exports: Persisted* schemas/types, Legacy* migration types, DraftThreadEnvMode(Schema), DraftThreadEntryPointSchema, EMPTY_PERSISTED_DRAFT_STORE_STATE, COMPOSER_DRAFT_STORAGE_VERSION

import {
  ModelSelection,
  OrchestrationThreadPullRequest,
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  ProviderMentionReference,
  ProviderModelOptions,
  ProviderSkillReference,
  ProviderStartOptions,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const COMPOSER_DRAFT_STORAGE_KEY = "synara:composer-drafts:v1";
export const COMPOSER_DRAFT_STORAGE_VERSION = 4;

export const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;
export const DraftThreadEntryPointSchema = Schema.Literals(["chat", "terminal"]);

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});
export type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

export const PersistedQueuedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
  text: Schema.String,
});
export type PersistedQueuedTerminalContextDraft = typeof PersistedQueuedTerminalContextDraft.Type;

export const PersistedQueuedComposerChatTurn = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("chat"),
  createdAt: Schema.String,
  previewText: Schema.String,
  prompt: Schema.String,
  images: Schema.Array(PersistedComposerImageAttachment),
  assistantSelections: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        assistantMessageId: Schema.String,
        text: Schema.String,
      }),
    ),
  ),
  terminalContexts: Schema.Array(PersistedQueuedTerminalContextDraft),
  skills: Schema.Array(ProviderSkillReference),
  mentions: Schema.Array(ProviderMentionReference),
  selectedProvider: ProviderKind,
  selectedModel: Schema.NullOr(Schema.String),
  selectedPromptEffort: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  providerOptionsForDispatch: Schema.optionalKey(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  envMode: DraftThreadEnvModeSchema,
});
export type PersistedQueuedComposerChatTurn = typeof PersistedQueuedComposerChatTurn.Type;

export const PersistedQueuedComposerPlanFollowUp = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("plan-follow-up"),
  createdAt: Schema.String,
  previewText: Schema.String,
  text: Schema.String,
  interactionMode: ProviderInteractionMode,
  selectedProvider: ProviderKind,
  selectedModel: Schema.NullOr(Schema.String),
  selectedPromptEffort: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  providerOptionsForDispatch: Schema.optionalKey(ProviderStartOptions),
  runtimeMode: RuntimeMode,
});
export type PersistedQueuedComposerPlanFollowUp = typeof PersistedQueuedComposerPlanFollowUp.Type;

export const PersistedQueuedComposerTurn = Schema.Union([
  PersistedQueuedComposerChatTurn,
  PersistedQueuedComposerPlanFollowUp,
]);
export type PersistedQueuedComposerTurn = typeof PersistedQueuedComposerTurn.Type;

export const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  assistantSelections: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        assistantMessageId: Schema.String,
        text: Schema.String,
      }),
    ),
  ),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  skills: Schema.optionalKey(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optionalKey(Schema.Array(ProviderMentionReference)),
  queuedTurns: Schema.optionalKey(Schema.Array(PersistedQueuedComposerTurn)),
  modelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

export const LegacyCodexFields = Schema.Struct({
  effort: Schema.optionalKey(Schema.String),
  codexFastMode: Schema.optionalKey(Schema.Boolean),
  serviceTier: Schema.optionalKey(Schema.String),
});
export type LegacyCodexFields = typeof LegacyCodexFields.Type;

const LegacyThreadModelFields = Schema.Struct({
  provider: Schema.optionalKey(ProviderKind),
  model: Schema.optionalKey(Schema.String),
  modelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});
type LegacyThreadModelFields = typeof LegacyThreadModelFields.Type;

type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: ProviderModelOptions | null;
};

export type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

const LegacyStickyModelFields = Schema.Struct({
  stickyProvider: Schema.optionalKey(ProviderKind),
  stickyModel: Schema.optionalKey(Schema.String),
  stickyModelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});
type LegacyStickyModelFields = typeof LegacyStickyModelFields.Type;

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: ProviderModelOptions | null;
};

export type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

export const PersistedDraftThreadState = Schema.Struct({
  projectId: ProjectId,
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  entryPoint: DraftThreadEntryPointSchema.pipe(Schema.withDecodingDefault(() => "chat")),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  lastKnownPr: Schema.optionalKey(Schema.NullOr(OrchestrationThreadPullRequest)),
  envMode: DraftThreadEnvModeSchema,
  isTemporary: Schema.optionalKey(Schema.Boolean),
  promotedTo: Schema.optionalKey(ThreadId),
});
export type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

export const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadId: Schema.Record(ThreadId, PersistedComposerThreadDraftState),
  draftThreadsByThreadId: Schema.Record(ThreadId, PersistedDraftThreadState),
  projectDraftThreadIdByProjectId: Schema.Record(ProjectId, ThreadId),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
});
export type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

export const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

export const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadId: {},
  draftThreadsByThreadId: {},
  projectDraftThreadIdByProjectId: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
});
