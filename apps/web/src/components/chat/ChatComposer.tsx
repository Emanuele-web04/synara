import type { ComponentProps, ReactNode, Ref, RefObject } from "react";

import type { ProviderMentionReference } from "@t3tools/contracts";

import type { ContextWindowSelectionStatus } from "../../lib/contextWindow";

import type {
  ComposerImageAttachment,
  ComposerAssistantSelectionAttachment,
  QueuedComposerTurn,
} from "../../composerDraftStore";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { FileCommentDraft } from "../../lib/fileComments";
import { cn } from "~/lib/utils";
import { ChevronDownIcon, ComposerSendArrowIcon, QueueArrow } from "~/lib/icons";
import { GoTasklist } from "react-icons/go";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_SURFACE_BORDER_CLASS_NAME,
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_APPROVAL_ROW_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
} from "./composerPickerStyles";
import { getComposerProviderState } from "./composerProviderRegistry";
import { getComposerTraitSelection } from "./composerTraits";
import { QueuedComposerActions } from "./QueuedComposerActions";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ComposerCommandMenu } from "./ComposerCommandMenu";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "./ComposerLocalDirectoryMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerExtrasMenu } from "./ComposerExtrasMenu";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";
import { ComposerReferenceAttachments } from "./ComposerReferenceAttachments";
import { RuntimeUsageControls, type RuntimeUsageControlsProps } from "../BranchToolbar";
import { ProjectPicker } from "./ProjectPicker";

type ComposerProviderState = ReturnType<typeof getComposerProviderState>;
type ComposerTraitSelection = ReturnType<typeof getComposerTraitSelection>;
type ComposerCommandMenuProps = ComponentProps<typeof ComposerCommandMenu>;
type ComposerPendingApprovalPanelProps = ComponentProps<typeof ComposerPendingApprovalPanel>;
type ComposerPendingUserInputPanelProps = ComponentProps<typeof ComposerPendingUserInputPanel>;
type ComposerLocalDirectoryMenuProps = ComponentProps<typeof ComposerLocalDirectoryMenu>;
type ContextWindowMeterProps = ComponentProps<typeof ContextWindowMeter>;

export interface ChatComposerProps {
  secondaryChromeReady: boolean;
  secondaryChromePlaceholderHeight: number;
  activeTaskListCard: ReactNode;
  composerFormRef: RefObject<HTMLFormElement | null>;
  onSend: ComponentProps<"form">["onSubmit"];
  paneScopeId: string | undefined;
  queuedComposerTurns: ReadonlyArray<QueuedComposerTurn>;
  taskListAboveComposer: boolean;
  onSteerQueuedComposerTurn: (queuedTurn: QueuedComposerTurn) => void;
  removeQueuedComposerTurn: (queuedTurnId: string) => void;
  onEditQueuedComposerTurn: (queuedTurn: QueuedComposerTurn) => void;
  composerHasStackedHeader: boolean;
  composerProviderState: ComposerProviderState;
  composerMenuOpen: boolean;
  isComposerApprovalState: boolean;
  onComposerDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onComposerDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  isDragOverComposer: boolean;
  activePendingApproval: ComposerPendingApprovalPanelProps["approval"] | null;
  pendingApprovals: ComposerPendingApprovalPanelProps["approval"][];
  pendingUserInputs: ComposerPendingUserInputPanelProps["pendingUserInputs"];
  respondingUserInputRequestIds: ComposerPendingUserInputPanelProps["respondingRequestIds"];
  activePendingDraftAnswers: ComposerPendingUserInputPanelProps["answers"];
  activePendingQuestionIndex: number;
  onToggleActivePendingUserInputOption: ComposerPendingUserInputPanelProps["onToggleOption"];
  onAdvanceActivePendingUserInput: ComposerPendingUserInputPanelProps["onAdvance"];
  onCancelActivePendingUserInput: ComposerPendingUserInputPanelProps["onCancel"];
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: { id: string; planMarkdown: string } | null;
  proposedPlanTitle: (planMarkdown: string) => string | null;
  isLocalFolderBrowserOpen: boolean;
  mentionTriggerQuery: string;
  localFolderBrowseRootPath: string | null;
  serverConfigHomeDir: string | null;
  handleSelectLocalDirectoryMention: (absolutePath: string) => void;
  handleNavigateLocalFolder: ComposerLocalDirectoryMenuProps["onNavigateFolder"];
  localDirectoryMenuRef: Ref<ComposerLocalDirectoryMenuHandle>;
  composerMenuItems: ComposerCommandMenuProps["items"];
  resolvedTheme: ComposerCommandMenuProps["resolvedTheme"];
  isComposerMenuLoading: boolean;
  composerCommandPicker: unknown;
  effectiveComposerTriggerKind: ComposerCommandMenuProps["triggerKind"];
  activeComposerMenuItem: ComposerCommandMenuProps["items"][number] | null;
  onComposerMenuItemHighlighted: ComposerCommandMenuProps["onHighlightedItemChange"];
  onSelectComposerItem: ComposerCommandMenuProps["onSelect"];
  composerAssistantSelections: ReadonlyArray<ComposerAssistantSelectionAttachment>;
  composerFileComments: ReadonlyArray<FileCommentDraft>;
  composerImages: ReadonlyArray<ComposerImageAttachment>;
  nonPersistedComposerImageIdSet: ReadonlySet<string>;
  onExpandTimelineImage: ComponentProps<typeof ComposerReferenceAttachments>["onExpandImage"];
  clearComposerAssistantSelectionsFromDraft: () => void;
  clearComposerFileCommentsFromDraft: () => void;
  removeComposerImage: (imageId: string) => void;
  composerEditorRef: Ref<ComposerPromptEditorHandle>;
  activePendingProgress: {
    customAnswer: string;
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
  } | null;
  prompt: string;
  composerCursor: number;
  composerTerminalContexts: ReadonlyArray<TerminalContextDraft>;
  selectedComposerMentions: ReadonlyArray<ProviderMentionReference>;
  removeComposerTerminalContextFromDraft: ComponentProps<
    typeof ComposerPromptEditor
  >["onRemoveTerminalContext"];
  onPromptChange: ComponentProps<typeof ComposerPromptEditor>["onChange"];
  onComposerCommandKey: NonNullable<
    ComponentProps<typeof ComposerPromptEditor>["onCommandKeyDown"]
  >;
  onComposerPaste: ComponentProps<typeof ComposerPromptEditor>["onPaste"];
  hasLiveTurn: boolean;
  phase: string;
  isConnecting: boolean;
  respondingRequestIds: ReadonlyArray<string>;
  onRespondToApproval: ComponentProps<typeof ComposerPendingApprovalActions>["onRespondToApproval"];
  isComposerFooterCompact: boolean;
  isVoiceRecording: boolean;
  isVoiceTranscribing: boolean;
  interactionMode: ComponentProps<typeof ComposerExtrasMenu>["interactionMode"];
  composerTraitSelection: ComposerTraitSelection;
  addComposerImages: (files: File[]) => void;
  toggleFastMode: () => void;
  setPlanMode: ComponentProps<typeof ComposerExtrasMenu>["onSetPlanMode"];
  runtimeUsageControlsProps: RuntimeUsageControlsProps;
  toggleInteractionMode: () => void;
  activeTaskList: unknown;
  sidebarProposedPlan: unknown;
  planSidebarOpen: boolean;
  togglePlanSidebar: () => void;
  planSidebarLabel: string;
  isPreparingWorktree: boolean;
  runtimeUsageContextWindow: ContextWindowMeterProps["usage"] | null;
  activeCumulativeCostUsd: number | null;
  contextWindowSelectionStatus: ContextWindowSelectionStatus;
  composerModelEffortPickerControl: ReactNode;
  showVoiceNotesControl: boolean;
  voiceRecordingDurationLabel: string;
  voiceWaveformLevels: ComponentProps<typeof ComposerVoiceRecorderBar>["waveformLevels"];
  submitComposerVoiceRecording: () => Promise<void> | void;
  cancelComposerVoiceRecording: () => void;
  activePendingIsResponding: boolean;
  onPreviousActivePendingUserInputQuestion: () => void;
  activePendingResolvedAnswers: unknown;
  onInterrupt: () => Promise<void> | void;
  isSendBusy: boolean;
  onImplementPlanInNewThread: () => Promise<void> | void;
  toggleComposerVoiceRecording: () => void;
  activeProject: unknown;
  composerSendState: { hasSendableContent: boolean };
  isEmptyChatLanding: boolean;
  resolvedThreadWorktreePath: string | null;
  handleSelectWorkspaceRoot: (workspaceRoot: string) => void;
  handleResetWorkspaceToHome: () => void;
}

export function ChatComposer({
  secondaryChromeReady,
  secondaryChromePlaceholderHeight,
  activeTaskListCard,
  composerFormRef,
  onSend,
  paneScopeId,
  queuedComposerTurns,
  taskListAboveComposer,
  onSteerQueuedComposerTurn,
  removeQueuedComposerTurn,
  onEditQueuedComposerTurn,
  composerHasStackedHeader,
  composerProviderState,
  composerMenuOpen,
  isComposerApprovalState,
  onComposerDragEnter,
  onComposerDragOver,
  onComposerDragLeave,
  onComposerDrop,
  isDragOverComposer,
  activePendingApproval,
  pendingApprovals,
  pendingUserInputs,
  respondingUserInputRequestIds,
  activePendingDraftAnswers,
  activePendingQuestionIndex,
  onToggleActivePendingUserInputOption,
  onAdvanceActivePendingUserInput,
  onCancelActivePendingUserInput,
  showPlanFollowUpPrompt,
  activeProposedPlan,
  proposedPlanTitle,
  isLocalFolderBrowserOpen,
  mentionTriggerQuery,
  localFolderBrowseRootPath,
  serverConfigHomeDir,
  handleSelectLocalDirectoryMention,
  handleNavigateLocalFolder,
  localDirectoryMenuRef,
  composerMenuItems,
  resolvedTheme,
  isComposerMenuLoading,
  composerCommandPicker,
  effectiveComposerTriggerKind,
  activeComposerMenuItem,
  onComposerMenuItemHighlighted,
  onSelectComposerItem,
  composerAssistantSelections,
  composerFileComments,
  composerImages,
  nonPersistedComposerImageIdSet,
  onExpandTimelineImage,
  clearComposerAssistantSelectionsFromDraft,
  clearComposerFileCommentsFromDraft,
  removeComposerImage,
  composerEditorRef,
  activePendingProgress,
  prompt,
  composerCursor,
  composerTerminalContexts,
  selectedComposerMentions,
  removeComposerTerminalContextFromDraft,
  onPromptChange,
  onComposerCommandKey,
  onComposerPaste,
  hasLiveTurn,
  phase,
  isConnecting,
  respondingRequestIds,
  onRespondToApproval,
  isComposerFooterCompact,
  isVoiceRecording,
  isVoiceTranscribing,
  interactionMode,
  composerTraitSelection,
  addComposerImages,
  toggleFastMode,
  setPlanMode,
  runtimeUsageControlsProps,
  toggleInteractionMode,
  activeTaskList,
  sidebarProposedPlan,
  planSidebarOpen,
  togglePlanSidebar,
  planSidebarLabel,
  isPreparingWorktree,
  runtimeUsageContextWindow,
  activeCumulativeCostUsd,
  contextWindowSelectionStatus,
  composerModelEffortPickerControl,
  showVoiceNotesControl,
  voiceRecordingDurationLabel,
  voiceWaveformLevels,
  submitComposerVoiceRecording,
  cancelComposerVoiceRecording,
  activePendingIsResponding,
  onPreviousActivePendingUserInputQuestion,
  activePendingResolvedAnswers,
  onInterrupt,
  isSendBusy,
  onImplementPlanInNewThread,
  toggleComposerVoiceRecording,
  activeProject,
  composerSendState,
  isEmptyChatLanding,
  resolvedThreadWorktreePath,
  handleSelectWorkspaceRoot,
  handleResetWorkspaceToHome,
}: ChatComposerProps) {
  return secondaryChromeReady ? (
    <>
      {activeTaskListCard}
      <form
        ref={composerFormRef}
        onSubmit={onSend}
        className="relative z-10 w-full overflow-visible"
        data-chat-composer-form="true"
        data-chat-pane-scope={paneScopeId}
      >
        <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
          {queuedComposerTurns.length > 0 ? (
            <div className="flex w-full flex-col">
              {queuedComposerTurns.map((queuedTurn, queuedTurnIndex) => (
                <div
                  key={queuedTurn.id}
                  data-testid="queued-follow-up-row"
                  className={cn(
                    "chat-composer-surface flex items-center gap-2 border border-b-0 px-3 pt-2.5 pb-2.5 text-[12px]",
                    COMPOSER_SURFACE_BORDER_CLASS_NAME,
                    queuedTurnIndex === 0 && !taskListAboveComposer
                      ? "chat-composer-stacked-top"
                      : "rounded-none",
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <QueueArrow className="size-3 shrink-0 text-[var(--color-text-foreground-secondary)]" />
                    <span className="truncate text-[12px] font-medium text-foreground/85">
                      {queuedTurn.previewText}
                    </span>
                  </div>
                  <QueuedComposerActions
                    queuedTurn={queuedTurn}
                    onSteer={onSteerQueuedComposerTurn}
                    onRemove={removeQueuedComposerTurn}
                    onEdit={onEditQueuedComposerTurn}
                  />
                </div>
              ))}
            </div>
          ) : null}
          <div
            className={cn(
              COMPOSER_INPUT_SHELL_CLASS_NAME,
              composerHasStackedHeader && "!rounded-t-none",
              composerProviderState.composerFrameClassName,
              composerMenuOpen && !isComposerApprovalState && "overflow-visible",
            )}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            <div
              className={cn(
                COMPOSER_INPUT_SURFACE_CLASS_NAME,
                composerHasStackedHeader && "!rounded-t-none",
                isDragOverComposer ? "!bg-[var(--color-background-control)]" : "",
                composerProviderState.composerSurfaceClassName,
                composerMenuOpen && !isComposerApprovalState && "overflow-visible",
              )}
            >
              {activePendingApproval ? (
                <div
                  className={cn(
                    COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME,
                    composerHasStackedHeader && "!rounded-t-none",
                  )}
                >
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={pendingApprovals.length}
                  />
                </div>
              ) : pendingUserInputs.length > 0 ? (
                <div
                  className={cn(
                    COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME,
                    composerHasStackedHeader && "!rounded-t-none",
                  )}
                >
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    respondingRequestIds={respondingUserInputRequestIds}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onToggleActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onCancel={onCancelActivePendingUserInput}
                  />
                </div>
              ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                <div
                  className={cn(
                    COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME,
                    composerHasStackedHeader && "!rounded-t-none",
                  )}
                >
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                </div>
              ) : null}
              <div
                className={cn(
                  COMPOSER_EDITOR_PADDING_CLASS_NAME,
                  composerMenuOpen && !isComposerApprovalState && "overflow-visible",
                )}
              >
                {composerMenuOpen && !isComposerApprovalState ? (
                  <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                    {isLocalFolderBrowserOpen ? (
                      <ComposerLocalDirectoryMenu
                        mentionQuery={mentionTriggerQuery}
                        rootLabel={localFolderBrowseRootPath ?? "Local folders unavailable"}
                        homeDir={serverConfigHomeDir}
                        onSelectEntry={(absolutePath) =>
                          handleSelectLocalDirectoryMention(absolutePath)
                        }
                        onNavigateFolder={handleNavigateLocalFolder}
                        handleRef={localDirectoryMenuRef}
                      />
                    ) : (
                      <ComposerCommandMenu
                        items={composerMenuItems}
                        resolvedTheme={resolvedTheme}
                        isLoading={isComposerMenuLoading}
                        triggerKind={
                          composerCommandPicker !== null
                            ? "slash-command"
                            : effectiveComposerTriggerKind
                        }
                        activeItemId={activeComposerMenuItem?.id ?? null}
                        onHighlightedItemChange={onComposerMenuItemHighlighted}
                        onSelect={onSelectComposerItem}
                      />
                    )}
                  </div>
                ) : null}
                {!isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  (composerAssistantSelections.length > 0 ||
                    composerFileComments.length > 0 ||
                    composerImages.length > 0) && (
                    <ComposerReferenceAttachments
                      assistantSelections={composerAssistantSelections}
                      fileComments={composerFileComments}
                      images={composerImages}
                      nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
                      onExpandImage={onExpandTimelineImage}
                      onRemoveAssistantSelections={clearComposerAssistantSelectionsFromDraft}
                      onRemoveFileComments={clearComposerFileCommentsFromDraft}
                      onRemoveImage={removeComposerImage}
                    />
                  )}
                <ComposerPromptEditor
                  ref={composerEditorRef}
                  value={
                    isComposerApprovalState
                      ? ""
                      : activePendingProgress
                        ? activePendingProgress.customAnswer
                        : prompt
                  }
                  cursor={composerCursor}
                  terminalContexts={
                    !isComposerApprovalState && pendingUserInputs.length === 0
                      ? composerTerminalContexts
                      : []
                  }
                  mentionReferences={selectedComposerMentions}
                  onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                  onChange={onPromptChange}
                  onCommandKeyDown={onComposerCommandKey}
                  onPaste={onComposerPaste}
                  ariaLabel="Message composer"
                  placeholder={
                    isComposerApprovalState
                      ? "Resolve this approval request to continue"
                      : activePendingProgress
                        ? "Type your own answer, or leave this blank to use the selected option"
                        : showPlanFollowUpPrompt && activeProposedPlan
                          ? "Add feedback to refine the plan, or leave this blank to implement it"
                          : hasLiveTurn
                            ? "Ask for follow-up changes"
                            : phase === "disconnected"
                              ? "Ask for follow-up changes or attach images"
                              : "Ask anything, @tag files/folders, or use / to show available commands"
                  }
                  disabled={isConnecting || isComposerApprovalState}
                />
              </div>
              {/* Bottom toolbar */}
              {activePendingApproval ? (
                <div className={COMPOSER_FOOTER_APPROVAL_ROW_CLASS_NAME}>
                  <ComposerPendingApprovalActions
                    requestId={activePendingApproval.requestId}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              ) : (
                <div
                  data-chat-composer-footer="true"
                  className={cn(
                    "@container",
                    COMPOSER_FOOTER_ROW_CLASS_NAME,
                    isComposerFooterCompact
                      ? "gap-1.5"
                      : "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0",
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center",
                      isVoiceRecording || isVoiceTranscribing
                        ? "min-w-0 shrink-0 gap-1"
                        : isComposerFooterCompact
                          ? "min-w-0 flex-1 gap-1 overflow-hidden"
                          : "min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                    )}
                  >
                    <ComposerExtrasMenu
                      interactionMode={interactionMode}
                      supportsFastMode={composerTraitSelection.caps.supportsFastMode}
                      fastModeEnabled={composerTraitSelection.fastModeEnabled}
                      onAddPhotos={addComposerImages}
                      onToggleFastMode={toggleFastMode}
                      onSetPlanMode={setPlanMode}
                    />

                    {!isVoiceRecording && !isVoiceTranscribing ? (
                      <>
                        <RuntimeUsageControls {...runtimeUsageControlsProps} className="shrink-0" />

                        {interactionMode === "plan" ? (
                          <Button
                            variant="ghost"
                            className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] sm:px-3"
                            size="sm"
                            type="button"
                            onClick={toggleInteractionMode}
                            title="Plan mode — click to return to normal build mode"
                          >
                            <GoTasklist className="size-3.5" />
                            <span className="sr-only sm:not-sr-only">Plan</span>
                          </Button>
                        ) : null}

                        {activeTaskList || sidebarProposedPlan || planSidebarOpen ? (
                          <Button
                            variant="ghost"
                            className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal sm:px-3"
                            size="sm"
                            type="button"
                            onClick={togglePlanSidebar}
                            title={
                              planSidebarOpen
                                ? `Hide ${planSidebarLabel.toLowerCase()} sidebar`
                                : `Show ${planSidebarLabel.toLowerCase()} sidebar`
                            }
                          >
                            <GoTasklist className="size-3.5" />
                            <span className="sr-only sm:not-sr-only">
                              {planSidebarOpen ? `Hide ${planSidebarLabel}` : planSidebarLabel}
                            </span>
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </div>

                  <div
                    data-chat-composer-actions="right"
                    className={cn(
                      "flex items-center gap-2",
                      isVoiceRecording || isVoiceTranscribing ? "min-w-0 flex-1" : "shrink-0",
                    )}
                  >
                    {isPreparingWorktree ? (
                      <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--color-text-foreground-secondary)]">
                        Preparing worktree...
                      </span>
                    ) : null}
                    {!isVoiceRecording && !isVoiceTranscribing && runtimeUsageContextWindow ? (
                      <ContextWindowMeter
                        usage={runtimeUsageContextWindow}
                        {...(activeCumulativeCostUsd != null
                          ? { cumulativeCostUsd: activeCumulativeCostUsd }
                          : {})}
                        {...(contextWindowSelectionStatus.activeLabel !== undefined
                          ? {
                              activeWindowLabel: contextWindowSelectionStatus.activeLabel,
                            }
                          : {})}
                        {...(contextWindowSelectionStatus.pendingSelectedLabel !== undefined
                          ? {
                              pendingWindowLabel: contextWindowSelectionStatus.pendingSelectedLabel,
                            }
                          : {})}
                      />
                    ) : null}
                    {!isVoiceRecording && !isVoiceTranscribing
                      ? composerModelEffortPickerControl
                      : null}
                    {showVoiceNotesControl && (isVoiceRecording || isVoiceTranscribing) ? (
                      <ComposerVoiceRecorderBar
                        disabled={isComposerApprovalState || isConnecting || isSendBusy}
                        isRecording={isVoiceRecording}
                        isTranscribing={isVoiceTranscribing}
                        durationLabel={voiceRecordingDurationLabel}
                        waveformLevels={voiceWaveformLevels}
                        onCancel={() => {
                          if (isVoiceRecording) {
                            void submitComposerVoiceRecording();
                            return;
                          }
                          cancelComposerVoiceRecording();
                        }}
                        onSubmit={() => {
                          void submitComposerVoiceRecording();
                        }}
                      />
                    ) : null}
                    {activePendingProgress ? (
                      <div className="flex items-center gap-2">
                        {activePendingProgress.questionIndex > 0 ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            onClick={onPreviousActivePendingUserInputQuestion}
                            disabled={activePendingIsResponding}
                          >
                            Previous
                          </Button>
                        ) : null}
                        <Button
                          type="submit"
                          size="sm"
                          className="rounded-full px-4"
                          disabled={
                            activePendingIsResponding ||
                            (activePendingProgress.isLastQuestion
                              ? !activePendingResolvedAnswers
                              : !activePendingProgress.canAdvance)
                          }
                        >
                          {activePendingIsResponding
                            ? "Submitting..."
                            : activePendingProgress.isLastQuestion
                              ? "Submit answers"
                              : "Next question"}
                        </Button>
                      </div>
                    ) : phase === "running" ? (
                      <Button
                        type="button"
                        variant="prominent"
                        size="icon-xs"
                        className="sm:size-[26px]"
                        onClick={() => void onInterrupt()}
                        aria-label="Stop generation"
                        title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                      >
                        <span
                          aria-hidden="true"
                          className="block size-2 rounded-[2px] bg-current"
                        />
                      </Button>
                    ) : pendingUserInputs.length === 0 &&
                      !isVoiceRecording &&
                      !isVoiceTranscribing ? (
                      showPlanFollowUpPrompt ? (
                        prompt.trim().length > 0 ? (
                          <Button
                            type="submit"
                            size="sm"
                            className="h-9 rounded-full px-4 sm:h-8"
                            disabled={isSendBusy || isConnecting}
                          >
                            {isConnecting || isSendBusy ? "Sending..." : "Refine"}
                          </Button>
                        ) : (
                          <div className="flex items-center">
                            <Button
                              type="submit"
                              size="sm"
                              className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                              disabled={isSendBusy || isConnecting}
                            >
                              {isConnecting || isSendBusy ? "Sending..." : "Implement"}
                            </Button>
                            <Menu>
                              <MenuTrigger
                                render={
                                  <Button
                                    size="sm"
                                    variant="default"
                                    className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                                    aria-label="Implementation actions"
                                    disabled={isSendBusy || isConnecting}
                                  />
                                }
                              >
                                <ChevronDownIcon className="size-3.5" />
                              </MenuTrigger>
                              <MenuPopup align="end" side="top">
                                <MenuItem
                                  disabled={isSendBusy || isConnecting}
                                  onClick={() => void onImplementPlanInNewThread()}
                                >
                                  Implement in a new thread
                                </MenuItem>
                              </MenuPopup>
                            </Menu>
                          </div>
                        )
                      ) : (
                        <>
                          {showVoiceNotesControl ? (
                            <ComposerVoiceButton
                              disabled={isComposerApprovalState || isConnecting || isSendBusy}
                              isRecording={isVoiceRecording}
                              isTranscribing={isVoiceTranscribing}
                              durationLabel={voiceRecordingDurationLabel}
                              onClick={toggleComposerVoiceRecording}
                            />
                          ) : null}
                          <Button
                            type="submit"
                            variant="prominent"
                            size="icon-xs"
                            className="size-7 rounded-full sm:size-7"
                            disabled={
                              isSendBusy ||
                              isConnecting ||
                              isVoiceTranscribing ||
                              !activeProject ||
                              !composerSendState.hasSendableContent
                            }
                            aria-label={
                              isConnecting
                                ? "Connecting"
                                : isVoiceTranscribing
                                  ? "Transcribing voice note"
                                  : !activeProject
                                    ? "Select a project before sending"
                                    : isPreparingWorktree
                                      ? "Preparing worktree"
                                      : isSendBusy
                                        ? "Sending"
                                        : "Send message"
                            }
                          >
                            {isConnecting || isSendBusy ? (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 14 14"
                                fill="none"
                                className="animate-spin"
                                aria-hidden="true"
                              >
                                <circle
                                  cx="7"
                                  cy="7"
                                  r="5.5"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeDasharray="20 12"
                                />
                              </svg>
                            ) : (
                              <ComposerSendArrowIcon
                                aria-hidden="true"
                                className="size-5 shrink-0"
                              />
                            )}
                          </Button>
                        </>
                      )
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </form>
      {isEmptyChatLanding ? (
        <div
          className={cn(
            "mt-2 flex items-center justify-start gap-3 px-3",
            COMPOSER_COLUMN_FRAME_CLASS_NAME,
          )}
        >
          <ProjectPicker
            align="start"
            side="top"
            showResetToHome={Boolean(resolvedThreadWorktreePath)}
            selectedWorkspaceRoot={resolvedThreadWorktreePath}
            onSelectWorkspaceRoot={handleSelectWorkspaceRoot}
            onResetToHome={handleResetWorkspaceToHome}
          />
        </div>
      ) : null}
    </>
  ) : (
    <div aria-hidden="true" className="w-full overflow-visible" data-chat-composer-form="deferred">
      <div
        className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, COMPOSER_COLUMN_FRAME_CLASS_NAME)}
        style={{ height: secondaryChromePlaceholderHeight }}
      />
    </div>
  );
}
