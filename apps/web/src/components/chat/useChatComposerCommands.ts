import {
  ThreadId,
  type ModelSlug,
  type ProviderKind,
  type ProviderSkillReference,
} from "@synara/contracts";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import { formatComposerMentionToken, skillMentionPrefix } from "~/lib/composerMentions";
import type { AppSettings } from "../../appSettings";
import { resolveFollowUpDispatchMode } from "../../appSettings";
import { collapseExpandedComposerCursor, detectComposerTrigger } from "../../composer-logic";
import {
  captureComposerPromptHistorySavedDraft,
  type QueuedComposerChatTurn,
} from "../../composerDraftStore";
import { useComposerSlashCommands } from "../../hooks/useComposerSlashCommands";
import { extractChatAutomationInvocation } from "../../lib/automationIntent";
import { syncTerminalContextsByIds, terminalContextIdListsEqual } from "../../lib/terminalContext";
import {
  promptStillMatchesActiveHistoryBrowse,
  resolvePromptHistoryNavigation,
  shouldHandlePromptHistoryNavigationKey,
} from "../ChatView.logic";
import { ComposerCommandItem } from "./ComposerCommandMenu";
import { type ComposerLocalDirectoryMenuHandle } from "./ComposerLocalDirectoryMenu";
import { composerPromptStillMatchesRestoredQueuedDraft } from "./queuedComposerPreview";
import { useChatComposerDraft } from "./useChatComposerDraft";
import { useChatComposerEditing } from "./useChatComposerEditing";
import { useChatPendingInteractions } from "./useChatPendingInteractions";
import { useChatRuntimeModes } from "./useChatRuntimeModes";
import { useComposerDiscovery } from "./useComposerDiscovery";
import { useComposerReferences } from "./useComposerReferences";

interface ChatComposerCommandsInput {
  threadId: ThreadId;
  composerSelectLockRef: RefObject<boolean>;
  setComposerCommandPicker: Dispatch<SetStateAction<"fork-target" | "review-target" | null>>;
  setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  handleForkTargetSelection: ReturnType<
    typeof useComposerSlashCommands
  >["handleForkTargetSelection"];
  handleReviewTargetSelection: ReturnType<
    typeof useComposerSlashCommands
  >["handleReviewTargetSelection"];
  resolveActiveComposerTrigger: ReturnType<
    typeof useChatComposerEditing
  >["resolveActiveComposerTrigger"];
  applyComposerTriggerReplacement: ReturnType<
    typeof useChatComposerEditing
  >["applyComposerTriggerReplacement"];
  handleNavigateLocalFolder: ReturnType<typeof useChatComposerEditing>["handleNavigateLocalFolder"];
  localFolderBrowseRootPath: string | null;
  handleSlashCommandSelection: ReturnType<
    typeof useComposerSlashCommands
  >["handleSlashCommandSelection"];
  selectedProvider: ProviderKind;
  scheduleComposerFocus: () => void;
  updateSelectedComposerSkills: ReturnType<
    typeof useComposerReferences
  >["updateSelectedComposerSkills"];
  updateSelectedComposerMentions: ReturnType<
    typeof useComposerReferences
  >["updateSelectedComposerMentions"];
  onProviderModelSelect: (provider: ProviderKind, model: ModelSlug) => Promise<void>;
  composerMenuItems: ComposerCommandItem[];
  composerHighlightedItemId: string | null;
  activePendingQuestion: ReturnType<typeof useChatPendingInteractions>["activePendingQuestion"];
  activePendingUserInput: ReturnType<typeof useChatPendingInteractions>["activePendingUserInput"];
  promptHistoryNavigationRef: ReturnType<typeof useChatComposerDraft>["promptHistoryNavigationRef"];
  restoreComposerDraftPromptHistorySavedDraft: ReturnType<
    typeof useChatComposerDraft
  >["restoreComposerDraftPromptHistorySavedDraft"];
  promptRef: ReturnType<typeof useChatComposerDraft>["promptRef"];
  setPrompt: ReturnType<typeof useChatComposerDraft>["setPrompt"];
  expectedPromptHistoryPromptRef: ReturnType<
    typeof useChatComposerDraft
  >["expectedPromptHistoryPromptRef"];
  onChangeActivePendingUserInputCustomAnswer: ReturnType<
    typeof useChatPendingInteractions
  >["onChangeActivePendingUserInputCustomAnswer"];
  setComposerDraftPromptHistorySavedDraft: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftPromptHistorySavedDraft"];
  applyingPromptHistoryNavigationRef: ReturnType<
    typeof useChatComposerDraft
  >["applyingPromptHistoryNavigationRef"];
  promptHistory: string[];
  promptHistoryAppliedPromptRef: ReturnType<
    typeof useChatComposerDraft
  >["promptHistoryAppliedPromptRef"];
  restoredQueuedSourceProposedPlanRef: ReturnType<
    typeof useChatComposerDraft
  >["restoredQueuedSourceProposedPlanRef"];
  setRestoredQueuedSourceProposedPlan: ReturnType<
    typeof useChatComposerDraft
  >["setRestoredQueuedSourceProposedPlan"];
  composerCommandPicker: "fork-target" | "review-target" | null;
  composerTerminalContexts: ReturnType<typeof useChatComposerDraft>["composerTerminalContexts"];
  setComposerDraftTerminalContexts: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftTerminalContexts"];
  setComposerCursor: ReturnType<typeof useChatComposerDraft>["setComposerCursor"];
  setComposerTrigger: ReturnType<typeof useChatComposerDraft>["setComposerTrigger"];
  clearComposerSlashDraft: ReturnType<typeof useChatComposerEditing>["clearComposerSlashDraft"];
  toggleInteractionMode: ReturnType<typeof useChatRuntimeModes>["toggleInteractionMode"];
  composerMenuOpenRef: RefObject<boolean>;
  onSend: (
    e?: { preventDefault: () => void },
    requestedDispatchMode?: "queue" | "steer",
    queuedTurn?: QueuedComposerChatTurn,
  ) => Promise<boolean>;
  settings: AppSettings;
  hasLiveTurn: boolean;
  isLocalFolderBrowserOpen: ReturnType<typeof useComposerDiscovery>["isLocalFolderBrowserOpen"];
  localDirectoryMenuRef: RefObject<ComposerLocalDirectoryMenuHandle | null>;
  composerMenuItemsRef: RefObject<ComposerCommandItem[]>;
  activeComposerMenuItemRef: RefObject<ComposerCommandItem | null>;
  activePendingProgress: ReturnType<typeof useChatPendingInteractions>["activePendingProgress"];
  isComposerApprovalState: boolean;
  pendingUserInputs: ReturnType<typeof useChatPendingInteractions>["pendingUserInputs"];
  composerDraft: ReturnType<typeof useChatComposerDraft>["composerDraft"];
}

export function useChatComposerCommands({
  threadId,
  composerSelectLockRef,
  setComposerCommandPicker,
  setComposerHighlightedItemId,
  handleForkTargetSelection,
  handleReviewTargetSelection,
  resolveActiveComposerTrigger,
  applyComposerTriggerReplacement,
  handleNavigateLocalFolder,
  localFolderBrowseRootPath,
  handleSlashCommandSelection,
  selectedProvider,
  scheduleComposerFocus,
  updateSelectedComposerSkills,
  updateSelectedComposerMentions,
  onProviderModelSelect,
  composerMenuItems,
  composerHighlightedItemId,
  activePendingQuestion,
  activePendingUserInput,
  promptHistoryNavigationRef,
  restoreComposerDraftPromptHistorySavedDraft,
  promptRef,
  setPrompt,
  expectedPromptHistoryPromptRef,
  onChangeActivePendingUserInputCustomAnswer,
  setComposerDraftPromptHistorySavedDraft,
  applyingPromptHistoryNavigationRef,
  promptHistory,
  promptHistoryAppliedPromptRef,
  restoredQueuedSourceProposedPlanRef,
  setRestoredQueuedSourceProposedPlan,
  composerCommandPicker,
  composerTerminalContexts,
  setComposerDraftTerminalContexts,
  setComposerCursor,
  setComposerTrigger,
  clearComposerSlashDraft,
  toggleInteractionMode,
  composerMenuOpenRef,
  onSend,
  settings,
  hasLiveTurn,
  isLocalFolderBrowserOpen,
  localDirectoryMenuRef,
  composerMenuItemsRef,
  activeComposerMenuItemRef,
  activePendingProgress,
  isComposerApprovalState,
  pendingUserInputs,
  composerDraft,
}: ChatComposerCommandsInput) {
  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      if (item.type === "fork-target") {
        setComposerCommandPicker(null);
        setComposerHighlightedItemId(null);
        void handleForkTargetSelection(item.target);
        return;
      }
      if (item.type === "review-target") {
        setComposerCommandPicker(null);
        setComposerHighlightedItemId(null);
        void handleReviewTargetSelection(item.target);
        return;
      }
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${formatComposerMentionToken(item.path)} `,
        });
        return;
      }
      if (item.type === "local-root") {
        handleNavigateLocalFolder(localFolderBrowseRootPath ?? "/");
        return;
      }
      if (item.type === "slash-command") {
        handleSlashCommandSelection(item);
        return;
      }
      if (item.type === "provider-native-command") {
        if (selectedProvider === "codex" && item.command.toLowerCase() === "review") {
          setComposerCommandPicker("review-target");
          setComposerHighlightedItemId("review-target:changes");
          scheduleComposerFocus();
          return;
        }
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `/${item.command} `,
        });
        return;
      }
      if (item.type === "skill") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${skillMentionPrefix(selectedProvider)}${item.skill.name} `,
          onApplied: () => {
            updateSelectedComposerSkills((existing) => {
              const nextSkill = {
                name: item.skill.name,
                path: item.skill.path,
              } satisfies ProviderSkillReference;
              return existing.some(
                (skill) => skill.name === nextSkill.name && skill.path === nextSkill.path,
              )
                ? existing
                : [...existing, nextSkill];
            });
          },
        });
        return;
      }
      if (item.type === "plugin" || item.type === "thread") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${formatComposerMentionToken(item.mention.name)} `,
          onApplied: () => {
            updateSelectedComposerMentions((existing) => {
              const nextMention = item.mention;
              const nextWithoutSameName = existing.filter(
                (mention) => mention.name !== nextMention.name,
              );
              return [...nextWithoutSameName, nextMention];
            });
          },
        });
        return;
      }
      if (item.type === "model") {
        onProviderModelSelect(item.provider, item.model);
        applyComposerTriggerReplacement({ snapshot, trigger, base: "" });
        return;
      }
      if (item.type === "agent") {
        // Insert @alias() and position cursor inside the parentheses.
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `@${item.alias}()`,
          cursorOffset: -1,
        });
      }
    },
    [
      composerSelectLockRef,
      setComposerHighlightedItemId,
      applyComposerTriggerReplacement,
      scheduleComposerFocus,
      handleForkTargetSelection,
      handleNavigateLocalFolder,
      handleReviewTargetSelection,
      handleSlashCommandSelection,
      onProviderModelSelect,
      setComposerCommandPicker,
      localFolderBrowseRootPath,
      selectedProvider,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
      resolveActiveComposerTrigger,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
    },
    [setComposerHighlightedItemId],
  );
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [setComposerHighlightedItemId, composerHighlightedItemId, composerMenuItems],
  );

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingQuestion && activePendingUserInput) {
        const interruptedNavigation = promptHistoryNavigationRef.current;
        if (interruptedNavigation !== null) {
          // An active question ended the history browse while the persisted
          // prompt still held a recalled entry; put the real draft back.
          promptHistoryNavigationRef.current = null;
          restoreComposerDraftPromptHistorySavedDraft(threadId);
          promptRef.current = interruptedNavigation.draft;
          setPrompt(interruptedNavigation.draft);
        }
        expectedPromptHistoryPromptRef.current = null;
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      const expectedPromptHistoryPrompt = expectedPromptHistoryPromptRef.current;
      if (expectedPromptHistoryPrompt !== null) {
        if (nextPrompt === expectedPromptHistoryPrompt) {
          expectedPromptHistoryPromptRef.current = null;
        } else {
          // The user edited past the recalled entry: the edited text is the
          // draft now, so the saved pre-browse draft must not be restored.
          promptHistoryNavigationRef.current = null;
          expectedPromptHistoryPromptRef.current = null;
          setComposerDraftPromptHistorySavedDraft(threadId, null);
        }
      } else if (!applyingPromptHistoryNavigationRef.current) {
        const activePromptHistoryNavigation = promptHistoryNavigationRef.current;
        if (
          activePromptHistoryNavigation !== null &&
          !promptStillMatchesActiveHistoryBrowse({
            state: activePromptHistoryNavigation,
            history: promptHistory,
            nextPrompt,
            appliedPrompt: promptHistoryAppliedPromptRef.current,
          })
        ) {
          promptHistoryNavigationRef.current = null;
          setComposerDraftPromptHistorySavedDraft(threadId, null);
        }
      }
      const restoredQueuedSource = restoredQueuedSourceProposedPlanRef.current;
      if (
        restoredQueuedSource?.threadId === threadId &&
        !composerPromptStillMatchesRestoredQueuedDraft(
          restoredQueuedSource.restoredPrompt,
          nextPrompt,
        )
      ) {
        setRestoredQueuedSourceProposedPlan(threadId, null);
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (composerCommandPicker !== null && nextPrompt.trim().length > 0) {
        setComposerCommandPicker(null);
      }
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      promptHistoryNavigationRef,
      promptRef,
      expectedPromptHistoryPromptRef,
      applyingPromptHistoryNavigationRef,
      promptHistoryAppliedPromptRef,
      restoredQueuedSourceProposedPlanRef,
      setComposerCursor,
      setComposerTrigger,
      activePendingQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      composerCommandPicker,
      onChangeActivePendingUserInputCustomAnswer,
      promptHistory,
      restoreComposerDraftPromptHistorySavedDraft,
      setPrompt,
      setComposerDraftPromptHistorySavedDraft,
      setComposerDraftTerminalContexts,
      setComposerCommandPicker,
      setRestoredQueuedSourceProposedPlan,
      threadId,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => {
    if (key === "Slash" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      const slashTriggerText =
        trigger && (trigger.kind === "slash-command" || trigger.kind === "slash-model")
          ? snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd)
          : null;

      if (slashTriggerText === "/" && snapshot.expandedCursor === trigger?.rangeEnd) {
        // Pressing `/` again on a lone `/` dismisses the picker. Only wipe the
        // draft when the slash IS the whole prompt; a mid-line slash (e.g. after
        // an existing chip) must keep surrounding content, so let it type through.
        if (trigger.rangeStart === 0 && trigger.rangeEnd === snapshot.value.length) {
          clearComposerSlashDraft();
          return true;
        }
        return false;
      }
      return false;
    }

    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }

    const { snapshot, trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (
      key === "Enter" &&
      !event.shiftKey &&
      !menuIsActive &&
      extractChatAutomationInvocation(snapshot.value) !== null
    ) {
      void onSend(
        undefined,
        resolveFollowUpDispatchMode({
          behavior: settings.followUpBehavior,
          hasLiveTurn,
          useOppositeBehavior: event.metaKey || event.ctrlKey,
        }),
      );
      return true;
    }

    if (menuIsActive && isLocalFolderBrowserOpen) {
      if (key === "ArrowDown") {
        localDirectoryMenuRef.current?.moveHighlight("down");
        return true;
      }
      if (key === "ArrowUp") {
        localDirectoryMenuRef.current?.moveHighlight("up");
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        localDirectoryMenuRef.current?.activateHighlighted();
        return true;
      }
    }

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (
      shouldHandlePromptHistoryNavigationKey({
        key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        menuIsActive,
        hasActivePendingProgress: Boolean(activePendingProgress),
        isComposerApprovalState,
        pendingUserInputCount: pendingUserInputs.length,
      })
    ) {
      const direction = key === "ArrowUp" ? "older" : "newer";
      const previousNavigationState = promptHistoryNavigationRef.current;
      const result = resolvePromptHistoryNavigation({
        direction,
        history: promptHistory,
        currentPrompt: snapshot.value,
        // Line-boundary math needs raw string offsets; the collapsed cursor
        // undercounts inline token chips (mentions, links, slash commands).
        currentExpandedCursor: snapshot.expandedCursor,
        selectionCollapsed: snapshot.selectionCollapsed,
        state: previousNavigationState,
      });
      if (result.handled) {
        promptHistoryNavigationRef.current = result.state;
        if (result.state === null) {
          restoreComposerDraftPromptHistorySavedDraft(threadId);
        } else if (previousNavigationState === null) {
          setComposerDraftPromptHistorySavedDraft(
            threadId,
            captureComposerPromptHistorySavedDraft({
              threadId,
              draft: composerDraft,
              prompt: result.state.draft,
            }),
          );
        }
        applyingPromptHistoryNavigationRef.current = true;
        expectedPromptHistoryPromptRef.current = result.prompt;
        promptHistoryAppliedPromptRef.current = result.prompt;
        promptRef.current = result.prompt;
        setPrompt(result.prompt);
        setComposerCursor(collapseExpandedComposerCursor(result.prompt, result.expandedCursor));
        // Recalled text replaces the whole prompt; suppress trigger detection
        // so an entry ending in a mention/slash token cannot pop a menu that
        // would capture the next arrow keypress.
        setComposerTrigger(null);
        window.requestAnimationFrame(() => {
          applyingPromptHistoryNavigationRef.current = false;
        });
        return true;
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      if (promptHistoryNavigationRef.current !== null) {
        // Sending commits the recalled text as the prompt; drop the saved
        // draft here (not just in the send path) so it cannot linger and
        // resurrect a stale draft if the send is rejected.
        promptHistoryNavigationRef.current = null;
        setComposerDraftPromptHistorySavedDraft(threadId, null);
      }
      expectedPromptHistoryPromptRef.current = null;
      void onSend(
        undefined,
        resolveFollowUpDispatchMode({
          behavior: settings.followUpBehavior,
          hasLiveTurn,
          useOppositeBehavior: event.metaKey || event.ctrlKey,
        }),
      );
      return true;
    }
    return false;
  };
  return {
    onSelectComposerItem,
    onComposerMenuItemHighlighted,
    onPromptChange,
    onComposerCommandKey,
  };
}
