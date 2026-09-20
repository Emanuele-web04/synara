import { Schema, Struct } from "effect";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

import {
  AutomationCancelRunInput,
  AutomationArchiveRunInput,
  AutomationCreateInput,
  AutomationDeleteInput,
  AutomationGetMemoryInput,
  AutomationListInput,
  AutomationMarkRunReadInput,
  AutomationResolveProposalInput,
  AutomationRunNowInput,
  AutomationStreamEvent,
  AutomationUpdateInput,
} from "./automation";
import {
  ProjectAgentConfigureInput,
  ProjectAgentExportDocumentsInput,
  ProjectAgentGetOverviewInput,
  ProjectAgentListSummariesInput,
  ProjectAgentGoalControlInput,
  ProjectAgentListActivityInput,
  ProjectAgentListDocumentsInput,
  ProjectAgentListTasksInput,
  ProjectAgentReadDocumentInput,
  ProjectAgentRefreshDigestInput,
  ProjectAgentStartGoalInput,
  ProjectAgentStreamEvent,
  ProjectAgentSubscribeInput,
  ProjectAgentUpdateGoalInput,
  ProjectAgentUpdateTaskInput,
  ProjectAgentWriteDocumentInput,
  ProjectAgentCreateTaskInput,
  ProjectAgentExcludeThreadInput,
  ProjectAgentBackfillInput,
  ProjectAgentListThreadIndexInput,
  ProjectAgentListEvidenceInput,
} from "./projectAgent";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationImportThreadInput,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
  OrchestrationUnsubscribeShellInput,
  OrchestrationUnsubscribeThreadInput,
  ORCHESTRATION_WS_CHANNELS,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetThreadDetailSnapshotInput,
  OrchestrationGetShellSnapshotInput,
  OrchestrationRepairStateInput,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsInput,
  OrchestrationRegenerateThreadTitleInput,
} from "./orchestration";
import {
  GitActionProgressEvent,
  GitBlameLineInput,
  GitReadFileAtRevInput,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateDetachedWorktreeInput,
  GitHubRepositoryInput,
  GitHandoffThreadInput,
  GitPreparePullRequestThreadInput,
  GitCreateWorktreeInput,
  GitInitInput,
  GitListBranchesInput,
  GitListRecentCommitsInput,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullRequestSnapshotInput,
  GitReadWorkingTreeDiffInput,
  GitRemoveWorktreeInput,
  GitRemoveIndexLockInput,
  GitRunStackedActionInput,
  GitStageFilesInput,
  GitStashAndCheckoutInput,
  GitStashDropInput,
  GitStashInfoInput,
  GitStatusInput,
  GitSummarizeDiffInput,
  GitUnstageFilesInput,
  GitWorktreeSetupProgressEvent,
} from "./git";
import {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "./terminal";
import { KeybindingRule } from "./keybindings";
import {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectDevServerEvent,
  ProjectDiscoverScriptsInput,
  ProjectListDirectoriesInput,
  ProjectReadFileInput,
  ProjectWatchFileInput,
  ProjectPrewarmSearchIndexInput,
  ProjectResolveWorkspaceFileReferencesInput,
  ProjectResolveOutOfRootFileReferenceInput,
  ProjectRunDevServerInput,
  ProjectSearchEntriesInput,
  ProjectSearchContentInput,
  ProjectSearchLocalEntriesInput,
  ProjectStopDevServerInput,
  ProjectWriteFileInput,
} from "./project";
import { StudioListThreadOutputsInput } from "./studio";
import { FilesystemBrowseInput } from "./filesystem";
import {
  DEVICE_WS_CHANNELS,
  DEVICE_WS_METHODS,
  DeviceAttachInput,
  DeviceBootInput,
  DeviceDescribeUiInput,
  DeviceScrollToElementInput,
  DeviceDetachInput,
  DeviceEvent,
  DeviceInstallAppInput,
  DeviceKeyEventInput,
  DeviceLaunchAppInput,
  DeviceListInput,
  DeviceOpenUrlInput,
  DevicePressButtonInput,
  DeviceScreenshotInput,
  DeviceStartRecordingInput,
  DeviceStopRecordingInput,
  DeviceShutdownInput,
  DeviceSwipeInput,
  DeviceTapInput,
  DeviceThreadInput,
  DeviceTypeTextInput,
} from "./device";
import { OpenInEditorInput } from "./editor";
import {
  ServerConfigUpdatedPayload,
  ServerGenerateAutomationIntentInput,
  ServerGenerateThreadRecapInput,
  ServerLifecycleStreamEvent,
  ServerProviderUpdateInput,
  ServerUpdateSettingsInput,
  ServerConsumeCodexResetCreditInput,
  ServerGetProviderUsageSnapshotInput,
  ServerListProviderUsageInput,
  ServerProviderStatusesUpdatedPayload,
  ServerSettingsUpdatedPayload,
  ServerStopLocalServerInput,
  ServerVoicePrewarmInput,
  ServerVoiceTranscriptionInput,
} from "./server";
import { StatsGetProfileStatsInput, StatsGetProfileTokenStatsInput } from "./stats";
import {
  ProviderListCommandsInput,
  ProviderGetComposerCapabilitiesInput,
  ProviderListPluginsInput,
  ProviderListModelsInput,
  ProviderListAgentsInput,
  ProviderReadPluginInput,
  ProviderListSkillsInput,
  ProviderSkillsCatalogInput,
} from "./providerDiscovery";
import { ProviderCompactThreadInput } from "./provider";
import {
  PullRequestActionInput,
  PullRequestCommentInput,
  PullRequestDetailInput,
  PullRequestReviewRequestCountInput,
  PullRequestSetPinnedInput,
  PullRequestsListInput,
} from "./pullRequests";
import {
  ExternalMcpCreateIntegrationInput,
  ExternalMcpRefreshPairingInput,
  ExternalMcpRevokeIntegrationInput,
} from "./externalMcp";
import {
  GitHubProjectProvisionInput,
  GitHubProjectProvisionProgressEvent,
} from "./githubProjectProvisioning";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  // Project registry methods
  projectsDiscoverScripts: "projects.discoverScripts",
  projectsListDirectories: "projects.listDirectories",
  projectsSearchEntries: "projects.searchEntries",
  projectsSearchLocalEntries: "projects.searchLocalEntries",
  projectsSearchContent: "projects.searchContent",
  projectsPrewarmSearchIndex: "projects.prewarmSearchIndex",
  projectsReadFile: "projects.readFile",
  projectsSubscribeFileChange: "projects.subscribeFileChange",
  projectsResolveWorkspaceFileReferences: "projects.resolveWorkspaceFileReferences",
  projectsResolveOutOfRootFileReference: "projects.resolveOutOfRootFileReference",
  projectsCreateLocalFilePreviewGrant: "projects.createLocalFilePreviewGrant",
  projectsWriteFile: "projects.writeFile",
  projectsRunDevServer: "projects.runDevServer",
  projectsStopDevServer: "projects.stopDevServer",
  projectsListDevServers: "projects.listDevServers",
  subscribeProjectDevServerEvents: "projects.subscribeDevServerEvents",
  projectsProvisionFromGitHub: "projects.provisionFromGitHub",

  // Studio methods
  studioListThreadOutputs: "studio.listThreadOutputs",

  // Filesystem browse methods
  filesystemBrowse: "filesystem.browse",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitGithubRepository: "git.githubRepository",
  gitStatus: "git.status",
  gitReadWorkingTreeDiff: "git.readWorkingTreeDiff",
  gitBlameLine: "git.blameLine",
  gitReadFileAtRev: "git.readFileAtRev",
  gitWorkingTreeDiffStats: "git.workingTreeDiffStats",
  gitSummarizeDiff: "git.summarizeDiff",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitListRecentCommits: "git.listRecentCommits",
  gitCreateWorktree: "git.createWorktree",
  gitCreateDetachedWorktree: "git.createDetachedWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitStashAndCheckout: "git.stashAndCheckout",
  gitStashDrop: "git.stashDrop",
  gitStashInfo: "git.stashInfo",
  gitRemoveIndexLock: "git.removeIndexLock",
  gitInit: "git.init",
  gitStageFiles: "git.stageFiles",
  gitUnstageFiles: "git.unstageFiles",
  gitHandoffThread: "git.handoffThread",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPullRequestSnapshot: "git.pullRequestSnapshot",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Global pull request methods
  pullRequestsList: "pullRequests.list",
  pullRequestsReviewRequestCount: "pullRequests.reviewRequestCount",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsDiff: "pullRequests.diff",
  pullRequestsAction: "pullRequests.action",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsSetPinned: "pullRequests.setPinned",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalAckOutput: "terminal.ackOutput",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverGetEnvironment: "server.getEnvironment",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverListExternalMcpIntegrations: "server.listExternalMcpIntegrations",
  serverCreateExternalMcpIntegration: "server.createExternalMcpIntegration",
  serverRevokeExternalMcpIntegration: "server.revokeExternalMcpIntegration",
  serverRefreshExternalMcpPairing: "server.refreshExternalMcpPairing",
  serverListWorktrees: "server.listWorktrees",
  serverListLocalServers: "server.listLocalServers",
  serverStopLocalServer: "server.stopLocalServer",
  serverGetProviderUsageSnapshot: "server.getProviderUsageSnapshot",
  serverListProviderUsage: "server.listProviderUsage",
  serverConsumeCodexResetCredit: "server.consumeCodexResetCredit",
  statsGetProfileStats: "stats.getProfileStats",
  statsGetProfileTokenStats: "stats.getProfileTokenStats",
  serverGetDiagnostics: "server.getDiagnostics",
  serverPrewarmVoice: "server.prewarmVoice",
  serverTranscribeVoice: "server.transcribeVoice",
  serverGenerateThreadRecap: "server.generateThreadRecap",
  serverGenerateAutomationIntent: "server.generateAutomationIntent",
  serverUpsertKeybinding: "server.upsertKeybinding",
  subscribeServerLifecycle: "server.subscribeLifecycle",
  subscribeServerConfig: "server.subscribeConfig",
  subscribeServerProviderStatuses: "server.subscribeProviderStatuses",
  subscribeServerSettings: "server.subscribeSettings",

  // Streaming subscriptions
  subscribeTerminalEvents: "terminal.subscribeEvents",
  subscribeOrchestrationDomainEvents: "orchestration.subscribeDomainEvents",

  // Provider discovery
  providerGetComposerCapabilities: "provider.getComposerCapabilities",
  providerCompactThread: "provider.compactThread",
  providerListCommands: "provider.listCommands",
  providerListSkills: "provider.listSkills",
  providerListSkillsCatalog: "provider.listSkillsCatalog",
  providerListPlugins: "provider.listPlugins",
  providerReadPlugin: "provider.readPlugin",
  providerListModels: "provider.listModels",
  providerListAgents: "provider.listAgents",

  // Automation methods
  automationList: "automation.list",
  automationGetMemory: "automation.getMemory",
  automationCreate: "automation.create",
  automationUpdate: "automation.update",
  automationDelete: "automation.delete",
  automationRunNow: "automation.runNow",
  automationCancelRun: "automation.cancelRun",
  automationMarkRunRead: "automation.markRunRead",
  automationArchiveRun: "automation.archiveRun",
  automationResolveProposal: "automation.resolveProposal",
  subscribeAutomationEvents: "automation.subscribe",

  projectAgentGetOverview: "projectAgent.getOverview",
  projectAgentListSummaries: "projectAgent.listSummaries",
  projectAgentConfigure: "projectAgent.configure",
  projectAgentStartGoal: "projectAgent.startGoal",
  projectAgentUpdateGoal: "projectAgent.updateGoal",
  projectAgentPauseGoal: "projectAgent.pauseGoal",
  projectAgentResumeGoal: "projectAgent.resumeGoal",
  projectAgentStopGoal: "projectAgent.stopGoal",
  projectAgentListTasks: "projectAgent.listTasks",
  projectAgentUpdateTask: "projectAgent.updateTask",
  projectAgentCreateTask: "projectAgent.createTask",
  projectAgentListEvidence: "projectAgent.listEvidence",
  projectAgentListThreadIndex: "projectAgent.listThreadIndex",
  projectAgentExcludeThread: "projectAgent.excludeThread",
  projectAgentBackfillSummaries: "projectAgent.backfillSummaries",
  projectAgentListActivity: "projectAgent.listActivity",
  projectAgentListDocuments: "projectAgent.listDocuments",
  projectAgentReadDocument: "projectAgent.readDocument",
  projectAgentWriteDocument: "projectAgent.writeDocument",
  projectAgentExportDocuments: "projectAgent.exportDocuments",
  projectAgentRefreshDigest: "projectAgent.refreshDigest",
  subscribeProjectAgentEvents: "projectAgent.subscribe",
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  automationEvent: "automation.event",
  gitActionProgress: "git.actionProgress",
  gitWorktreeSetupProgress: "git.worktreeSetupProgress",
  projectProvisionProgress: "project.provisionProgress",
  terminalEvent: "terminal.event",
  projectDevServerEvent: "project.devServerEvent",
  projectAgentEvent: "projectAgent.event",
  serverWelcome: "server.welcome",
  serverMaintenanceUpdated: "server.maintenanceUpdated",
  serverConfigUpdated: "server.configUpdated",
  serverProviderStatusesUpdated: "server.providerStatusesUpdated",
  serverSettingsUpdated: "server.settingsUpdated",
} as const;

// -- Tagged Union of all request body schemas ─────────────────────────

const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(
    Struct.assign({ _tag: Schema.tag(tag) }),
    // PreserveChecks is safe here. No existing schema should have checks depending on the tag
    { unsafePreserveChecks: true },
  );

const WebSocketRequestBody = Schema.Union([
  // Orchestration methods
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    Schema.Struct({ command: ClientOrchestrationCommand }),
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.importThread, OrchestrationImportThreadInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.regenerateThreadTitle,
    OrchestrationRegenerateThreadTitleInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getSnapshot, OrchestrationGetSnapshotInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getShellSnapshot, OrchestrationGetShellSnapshotInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
    OrchestrationGetThreadDetailSnapshotInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.repairState, OrchestrationRepairStateInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getTurnDiff, OrchestrationGetTurnDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getFullThreadDiff, OrchestrationGetFullThreadDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.replayEvents, OrchestrationReplayEventsInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.subscribeShell, OrchestrationSubscribeShellInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.unsubscribeShell, OrchestrationUnsubscribeShellInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.subscribeThread, OrchestrationSubscribeThreadInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.unsubscribeThread, OrchestrationUnsubscribeThreadInput),

  // Project Search
  tagRequestBody(WS_METHODS.projectsDiscoverScripts, ProjectDiscoverScriptsInput),
  tagRequestBody(WS_METHODS.projectsListDirectories, ProjectListDirectoriesInput),
  tagRequestBody(WS_METHODS.projectsSearchEntries, ProjectSearchEntriesInput),
  tagRequestBody(WS_METHODS.projectsSearchLocalEntries, ProjectSearchLocalEntriesInput),
  tagRequestBody(WS_METHODS.projectsSearchContent, ProjectSearchContentInput),
  tagRequestBody(WS_METHODS.projectsPrewarmSearchIndex, ProjectPrewarmSearchIndexInput),
  tagRequestBody(WS_METHODS.projectsReadFile, ProjectReadFileInput),
  tagRequestBody(WS_METHODS.projectsSubscribeFileChange, ProjectWatchFileInput),
  tagRequestBody(
    WS_METHODS.projectsResolveWorkspaceFileReferences,
    ProjectResolveWorkspaceFileReferencesInput,
  ),
  tagRequestBody(
    WS_METHODS.projectsResolveOutOfRootFileReference,
    ProjectResolveOutOfRootFileReferenceInput,
  ),
  tagRequestBody(
    WS_METHODS.projectsCreateLocalFilePreviewGrant,
    ProjectCreateLocalFilePreviewGrantInput,
  ),
  tagRequestBody(WS_METHODS.projectsWriteFile, ProjectWriteFileInput),
  tagRequestBody(WS_METHODS.projectsRunDevServer, ProjectRunDevServerInput),
  tagRequestBody(WS_METHODS.projectsStopDevServer, ProjectStopDevServerInput),
  tagRequestBody(WS_METHODS.projectsListDevServers, Schema.Struct({})),
  tagRequestBody(WS_METHODS.subscribeProjectDevServerEvents, Schema.Struct({})),
  tagRequestBody(WS_METHODS.projectsProvisionFromGitHub, GitHubProjectProvisionInput),

  // Filesystem browse
  // Studio
  tagRequestBody(WS_METHODS.studioListThreadOutputs, StudioListThreadOutputsInput),

  tagRequestBody(WS_METHODS.filesystemBrowse, FilesystemBrowseInput),

  // Device pane (macOS only; the server refuses these off darwin)
  tagRequestBody(DEVICE_WS_METHODS.list, DeviceListInput),
  tagRequestBody(DEVICE_WS_METHODS.boot, DeviceBootInput),
  tagRequestBody(DEVICE_WS_METHODS.shutdown, DeviceShutdownInput),
  tagRequestBody(DEVICE_WS_METHODS.attach, DeviceAttachInput),
  tagRequestBody(DEVICE_WS_METHODS.detach, DeviceDetachInput),
  tagRequestBody(DEVICE_WS_METHODS.getThreadState, DeviceThreadInput),
  tagRequestBody(DEVICE_WS_METHODS.tap, DeviceTapInput),
  tagRequestBody(DEVICE_WS_METHODS.swipe, DeviceSwipeInput),
  tagRequestBody(DEVICE_WS_METHODS.typeText, DeviceTypeTextInput),
  tagRequestBody(DEVICE_WS_METHODS.keyEvent, DeviceKeyEventInput),
  tagRequestBody(DEVICE_WS_METHODS.pressButton, DevicePressButtonInput),
  tagRequestBody(DEVICE_WS_METHODS.installApp, DeviceInstallAppInput),
  tagRequestBody(DEVICE_WS_METHODS.launchApp, DeviceLaunchAppInput),
  tagRequestBody(DEVICE_WS_METHODS.openUrl, DeviceOpenUrlInput),
  tagRequestBody(DEVICE_WS_METHODS.screenshot, DeviceScreenshotInput),
  tagRequestBody(DEVICE_WS_METHODS.startRecording, DeviceStartRecordingInput),
  tagRequestBody(DEVICE_WS_METHODS.stopRecording, DeviceStopRecordingInput),
  tagRequestBody(DEVICE_WS_METHODS.describeUi, DeviceDescribeUiInput),
  tagRequestBody(DEVICE_WS_METHODS.scrollToElement, DeviceScrollToElementInput),
  tagRequestBody(DEVICE_WS_METHODS.subscribeEvents, Schema.Struct({})),

  // Shell methods
  tagRequestBody(WS_METHODS.shellOpenInEditor, OpenInEditorInput),

  // Git methods
  tagRequestBody(WS_METHODS.gitPull, GitPullInput),
  tagRequestBody(WS_METHODS.gitGithubRepository, GitHubRepositoryInput),
  tagRequestBody(WS_METHODS.gitStatus, GitStatusInput),
  tagRequestBody(WS_METHODS.gitReadWorkingTreeDiff, GitReadWorkingTreeDiffInput),
  tagRequestBody(WS_METHODS.gitBlameLine, GitBlameLineInput),
  tagRequestBody(WS_METHODS.gitReadFileAtRev, GitReadFileAtRevInput),
  tagRequestBody(WS_METHODS.gitWorkingTreeDiffStats, GitReadWorkingTreeDiffInput),
  tagRequestBody(WS_METHODS.gitSummarizeDiff, GitSummarizeDiffInput),
  tagRequestBody(WS_METHODS.gitRunStackedAction, GitRunStackedActionInput),
  tagRequestBody(WS_METHODS.gitListBranches, GitListBranchesInput),
  tagRequestBody(WS_METHODS.gitListRecentCommits, GitListRecentCommitsInput),
  tagRequestBody(WS_METHODS.gitCreateWorktree, GitCreateWorktreeInput),
  tagRequestBody(WS_METHODS.gitCreateDetachedWorktree, GitCreateDetachedWorktreeInput),
  tagRequestBody(WS_METHODS.gitRemoveWorktree, GitRemoveWorktreeInput),
  tagRequestBody(WS_METHODS.gitCreateBranch, GitCreateBranchInput),
  tagRequestBody(WS_METHODS.gitCheckout, GitCheckoutInput),
  tagRequestBody(WS_METHODS.gitStashAndCheckout, GitStashAndCheckoutInput),
  tagRequestBody(WS_METHODS.gitStashDrop, GitStashDropInput),
  tagRequestBody(WS_METHODS.gitStashInfo, GitStashInfoInput),
  tagRequestBody(WS_METHODS.gitRemoveIndexLock, GitRemoveIndexLockInput),
  tagRequestBody(WS_METHODS.gitInit, GitInitInput),
  tagRequestBody(WS_METHODS.gitStageFiles, GitStageFilesInput),
  tagRequestBody(WS_METHODS.gitUnstageFiles, GitUnstageFilesInput),
  tagRequestBody(WS_METHODS.gitHandoffThread, GitHandoffThreadInput),
  tagRequestBody(WS_METHODS.gitResolvePullRequest, GitPullRequestRefInput),
  tagRequestBody(WS_METHODS.gitPullRequestSnapshot, GitPullRequestSnapshotInput),
  tagRequestBody(WS_METHODS.gitPreparePullRequestThread, GitPreparePullRequestThreadInput),

  // Global pull requests
  tagRequestBody(WS_METHODS.pullRequestsList, PullRequestsListInput),
  tagRequestBody(WS_METHODS.pullRequestsReviewRequestCount, PullRequestReviewRequestCountInput),
  tagRequestBody(WS_METHODS.pullRequestsDetail, PullRequestDetailInput),
  tagRequestBody(WS_METHODS.pullRequestsDiff, PullRequestDetailInput),
  tagRequestBody(WS_METHODS.pullRequestsAction, PullRequestActionInput),
  tagRequestBody(WS_METHODS.pullRequestsComment, PullRequestCommentInput),
  tagRequestBody(WS_METHODS.pullRequestsSetPinned, PullRequestSetPinnedInput),

  // Terminal methods
  tagRequestBody(WS_METHODS.terminalOpen, TerminalOpenInput),
  tagRequestBody(WS_METHODS.terminalWrite, TerminalWriteInput),
  tagRequestBody(WS_METHODS.terminalAckOutput, TerminalAckOutputInput),
  tagRequestBody(WS_METHODS.terminalResize, TerminalResizeInput),
  tagRequestBody(WS_METHODS.terminalClear, TerminalClearInput),
  tagRequestBody(WS_METHODS.terminalRestart, TerminalRestartInput),
  tagRequestBody(WS_METHODS.terminalClose, TerminalCloseInput),

  // Server meta
  tagRequestBody(WS_METHODS.serverGetConfig, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverGetEnvironment, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverGetSettings, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverUpdateSettings, ServerUpdateSettingsInput),
  tagRequestBody(WS_METHODS.serverRefreshProviders, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverUpdateProvider, ServerProviderUpdateInput),
  tagRequestBody(WS_METHODS.serverListExternalMcpIntegrations, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverCreateExternalMcpIntegration, ExternalMcpCreateIntegrationInput),
  tagRequestBody(WS_METHODS.serverRevokeExternalMcpIntegration, ExternalMcpRevokeIntegrationInput),
  tagRequestBody(WS_METHODS.serverRefreshExternalMcpPairing, ExternalMcpRefreshPairingInput),
  tagRequestBody(WS_METHODS.serverListWorktrees, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverListLocalServers, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverStopLocalServer, ServerStopLocalServerInput),
  tagRequestBody(WS_METHODS.serverGetProviderUsageSnapshot, ServerGetProviderUsageSnapshotInput),
  tagRequestBody(WS_METHODS.serverListProviderUsage, ServerListProviderUsageInput),
  tagRequestBody(WS_METHODS.serverConsumeCodexResetCredit, ServerConsumeCodexResetCreditInput),
  tagRequestBody(WS_METHODS.statsGetProfileStats, StatsGetProfileStatsInput),
  tagRequestBody(WS_METHODS.statsGetProfileTokenStats, StatsGetProfileTokenStatsInput),
  tagRequestBody(WS_METHODS.serverGetDiagnostics, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverPrewarmVoice, ServerVoicePrewarmInput),
  tagRequestBody(WS_METHODS.serverTranscribeVoice, ServerVoiceTranscriptionInput),
  tagRequestBody(WS_METHODS.serverGenerateThreadRecap, ServerGenerateThreadRecapInput),
  tagRequestBody(WS_METHODS.serverGenerateAutomationIntent, ServerGenerateAutomationIntentInput),
  tagRequestBody(WS_METHODS.serverUpsertKeybinding, KeybindingRule),

  // Provider discovery
  tagRequestBody(WS_METHODS.providerGetComposerCapabilities, ProviderGetComposerCapabilitiesInput),
  tagRequestBody(WS_METHODS.providerCompactThread, ProviderCompactThreadInput),
  tagRequestBody(WS_METHODS.providerListCommands, ProviderListCommandsInput),
  tagRequestBody(WS_METHODS.providerListSkills, ProviderListSkillsInput),
  tagRequestBody(WS_METHODS.providerListSkillsCatalog, ProviderSkillsCatalogInput),
  tagRequestBody(WS_METHODS.providerListPlugins, ProviderListPluginsInput),
  tagRequestBody(WS_METHODS.providerReadPlugin, ProviderReadPluginInput),
  tagRequestBody(WS_METHODS.providerListModels, ProviderListModelsInput),
  tagRequestBody(WS_METHODS.providerListAgents, ProviderListAgentsInput),

  // Automation methods
  tagRequestBody(WS_METHODS.automationList, AutomationListInput),
  tagRequestBody(WS_METHODS.automationGetMemory, AutomationGetMemoryInput),
  tagRequestBody(WS_METHODS.automationCreate, AutomationCreateInput),
  tagRequestBody(WS_METHODS.automationUpdate, AutomationUpdateInput),
  tagRequestBody(WS_METHODS.automationDelete, AutomationDeleteInput),
  tagRequestBody(WS_METHODS.automationRunNow, AutomationRunNowInput),
  tagRequestBody(WS_METHODS.automationCancelRun, AutomationCancelRunInput),
  tagRequestBody(WS_METHODS.automationMarkRunRead, AutomationMarkRunReadInput),
  tagRequestBody(WS_METHODS.automationArchiveRun, AutomationArchiveRunInput),
  tagRequestBody(WS_METHODS.automationResolveProposal, AutomationResolveProposalInput),
  tagRequestBody(WS_METHODS.subscribeAutomationEvents, Schema.Struct({})),

  tagRequestBody(WS_METHODS.projectAgentGetOverview, ProjectAgentGetOverviewInput),
  tagRequestBody(WS_METHODS.projectAgentListSummaries, ProjectAgentListSummariesInput),
  tagRequestBody(WS_METHODS.projectAgentConfigure, ProjectAgentConfigureInput),
  tagRequestBody(WS_METHODS.projectAgentStartGoal, ProjectAgentStartGoalInput),
  tagRequestBody(WS_METHODS.projectAgentUpdateGoal, ProjectAgentUpdateGoalInput),
  tagRequestBody(WS_METHODS.projectAgentPauseGoal, ProjectAgentGoalControlInput),
  tagRequestBody(WS_METHODS.projectAgentResumeGoal, ProjectAgentGoalControlInput),
  tagRequestBody(WS_METHODS.projectAgentStopGoal, ProjectAgentGoalControlInput),
  tagRequestBody(WS_METHODS.projectAgentListTasks, ProjectAgentListTasksInput),
  tagRequestBody(WS_METHODS.projectAgentUpdateTask, ProjectAgentUpdateTaskInput),
  tagRequestBody(WS_METHODS.projectAgentCreateTask, ProjectAgentCreateTaskInput),
  tagRequestBody(WS_METHODS.projectAgentListEvidence, ProjectAgentListEvidenceInput),
  tagRequestBody(WS_METHODS.projectAgentListThreadIndex, ProjectAgentListThreadIndexInput),
  tagRequestBody(WS_METHODS.projectAgentExcludeThread, ProjectAgentExcludeThreadInput),
  tagRequestBody(WS_METHODS.projectAgentBackfillSummaries, ProjectAgentBackfillInput),
  tagRequestBody(WS_METHODS.projectAgentListActivity, ProjectAgentListActivityInput),
  tagRequestBody(WS_METHODS.projectAgentListDocuments, ProjectAgentListDocumentsInput),
  tagRequestBody(WS_METHODS.projectAgentReadDocument, ProjectAgentReadDocumentInput),
  tagRequestBody(WS_METHODS.projectAgentWriteDocument, ProjectAgentWriteDocumentInput),
  tagRequestBody(WS_METHODS.projectAgentExportDocuments, ProjectAgentExportDocumentsInput),
  tagRequestBody(WS_METHODS.projectAgentRefreshDigest, ProjectAgentRefreshDigestInput),
  tagRequestBody(WS_METHODS.subscribeProjectAgentEvents, ProjectAgentSubscribeInput),
]);

export const WebSocketRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: WebSocketRequestBody,
});
export type WebSocketRequest = typeof WebSocketRequest.Type;

export const WebSocketResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type WebSocketResponse = typeof WebSocketResponse.Type;

export const WsPushSequence = NonNegativeInt;
export type WsPushSequence = typeof WsPushSequence.Type;

export const WsWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  homeDir: Schema.optional(TrimmedNonEmptyString),
  chatWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  studioWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  groupsWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type WsWelcomePayload = typeof WsWelcomePayload.Type;

export interface WsPushPayloadByChannel {
  readonly [WS_CHANNELS.serverWelcome]: WsWelcomePayload;
  readonly [WS_CHANNELS.serverMaintenanceUpdated]: ServerLifecycleStreamEvent;
  readonly [WS_CHANNELS.serverConfigUpdated]: typeof ServerConfigUpdatedPayload.Type;
  readonly [WS_CHANNELS.serverProviderStatusesUpdated]: typeof ServerProviderStatusesUpdatedPayload.Type;
  readonly [WS_CHANNELS.serverSettingsUpdated]: typeof ServerSettingsUpdatedPayload.Type;
  readonly [WS_CHANNELS.automationEvent]: typeof AutomationStreamEvent.Type;
  readonly [WS_CHANNELS.projectAgentEvent]: typeof ProjectAgentStreamEvent.Type;
  readonly [WS_CHANNELS.gitActionProgress]: typeof GitActionProgressEvent.Type;
  readonly [WS_CHANNELS.gitWorktreeSetupProgress]: typeof GitWorktreeSetupProgressEvent.Type;
  readonly [WS_CHANNELS.projectProvisionProgress]: typeof GitHubProjectProvisionProgressEvent.Type;
  readonly [WS_CHANNELS.terminalEvent]: typeof TerminalEvent.Type;
  readonly [WS_CHANNELS.projectDevServerEvent]: typeof ProjectDevServerEvent.Type;
  readonly [DEVICE_WS_CHANNELS.event]: typeof DeviceEvent.Type;
  readonly [ORCHESTRATION_WS_CHANNELS.domainEvent]: OrchestrationEvent;
  readonly [ORCHESTRATION_WS_CHANNELS.shellEvent]: OrchestrationShellStreamItem;
  readonly [ORCHESTRATION_WS_CHANNELS.threadEvent]: OrchestrationThreadStreamItem;
}

export type WsPushChannel = keyof WsPushPayloadByChannel;
export type WsPushData<C extends WsPushChannel> = WsPushPayloadByChannel[C];

const makeWsPushSchema = <const Channel extends string, Payload extends Schema.Schema<any>>(
  channel: Channel,
  payload: Payload,
) =>
  Schema.Struct({
    type: Schema.Literal("push"),
    sequence: WsPushSequence,
    channel: Schema.Literal(channel),
    data: payload,
  });

export const WsPushServerWelcome = makeWsPushSchema(WS_CHANNELS.serverWelcome, WsWelcomePayload);
export const WsPushServerMaintenanceUpdated = makeWsPushSchema(
  WS_CHANNELS.serverMaintenanceUpdated,
  ServerLifecycleStreamEvent,
);
export const WsPushServerConfigUpdated = makeWsPushSchema(
  WS_CHANNELS.serverConfigUpdated,
  ServerConfigUpdatedPayload,
);
export const WsPushServerProviderStatusesUpdated = makeWsPushSchema(
  WS_CHANNELS.serverProviderStatusesUpdated,
  ServerProviderStatusesUpdatedPayload,
);
export const WsPushServerSettingsUpdated = makeWsPushSchema(
  WS_CHANNELS.serverSettingsUpdated,
  ServerSettingsUpdatedPayload,
);
export const WsPushAutomationEvent = makeWsPushSchema(
  WS_CHANNELS.automationEvent,
  AutomationStreamEvent,
);
export const WsPushProjectAgentEvent = makeWsPushSchema(
  WS_CHANNELS.projectAgentEvent,
  ProjectAgentStreamEvent,
);
export const WsPushGitActionProgress = makeWsPushSchema(
  WS_CHANNELS.gitActionProgress,
  GitActionProgressEvent,
);
export const WsPushGitWorktreeSetupProgress = makeWsPushSchema(
  WS_CHANNELS.gitWorktreeSetupProgress,
  GitWorktreeSetupProgressEvent,
);
export const WsPushProjectProvisionProgress = makeWsPushSchema(
  WS_CHANNELS.projectProvisionProgress,
  GitHubProjectProvisionProgressEvent,
);
export const WsPushTerminalEvent = makeWsPushSchema(WS_CHANNELS.terminalEvent, TerminalEvent);
export const WsPushProjectDevServerEvent = makeWsPushSchema(
  WS_CHANNELS.projectDevServerEvent,
  ProjectDevServerEvent,
);
export const WsPushDeviceEvent = makeWsPushSchema(DEVICE_WS_CHANNELS.event, DeviceEvent);
export const WsPushOrchestrationDomainEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  OrchestrationEvent,
);
export const WsPushOrchestrationShellEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.shellEvent,
  OrchestrationShellStreamItem,
);
export const WsPushOrchestrationThreadEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.threadEvent,
  OrchestrationThreadStreamItem,
);

export const WsPushChannelSchema = Schema.Literals([
  WS_CHANNELS.gitActionProgress,
  WS_CHANNELS.gitWorktreeSetupProgress,
  WS_CHANNELS.projectProvisionProgress,
  WS_CHANNELS.serverWelcome,
  WS_CHANNELS.serverMaintenanceUpdated,
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.serverProviderStatusesUpdated,
  WS_CHANNELS.serverSettingsUpdated,
  WS_CHANNELS.automationEvent,
  WS_CHANNELS.projectAgentEvent,
  WS_CHANNELS.terminalEvent,
  WS_CHANNELS.projectDevServerEvent,
  DEVICE_WS_CHANNELS.event,
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  ORCHESTRATION_WS_CHANNELS.shellEvent,
  ORCHESTRATION_WS_CHANNELS.threadEvent,
]);
export type WsPushChannelSchema = typeof WsPushChannelSchema.Type;

export const WsPush = Schema.Union([
  WsPushServerWelcome,
  WsPushServerMaintenanceUpdated,
  WsPushServerConfigUpdated,
  WsPushServerProviderStatusesUpdated,
  WsPushServerSettingsUpdated,
  WsPushAutomationEvent,
  WsPushProjectAgentEvent,
  WsPushGitActionProgress,
  WsPushGitWorktreeSetupProgress,
  WsPushProjectProvisionProgress,
  WsPushTerminalEvent,
  WsPushProjectDevServerEvent,
  WsPushDeviceEvent,
  WsPushOrchestrationDomainEvent,
  WsPushOrchestrationShellEvent,
  WsPushOrchestrationThreadEvent,
]);
export type WsPush = typeof WsPush.Type;

export type WsPushMessage<C extends WsPushChannel> = Extract<WsPush, { channel: C }>;

export const WsPushEnvelopeBase = Schema.Struct({
  type: Schema.Literal("push"),
  sequence: WsPushSequence,
  channel: WsPushChannelSchema,
  data: Schema.Unknown,
});
export type WsPushEnvelopeBase = typeof WsPushEnvelopeBase.Type;

// ── Union of all server → client messages ─────────────────────────────

export const WsResponse = Schema.Union([WebSocketResponse, WsPush]);
export type WsResponse = typeof WsResponse.Type;
