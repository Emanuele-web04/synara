import { ThreadId } from "@synara/contracts";
import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import {
  composerMentionPathNeedsQuoting,
  formatComposerMentionToken,
} from "~/lib/composerMentions";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
  type ComposerTrigger,
} from "../../composer-logic";
import {
  ensureLeadingSpaceForReplacement,
  extendReplacementRangeForTrailingSpace,
} from "../../composerTriggerInsertion";
import { setPendingUserInputCustomAnswer } from "../../pendingUserInput";
import { useChatComposerDraft } from "./useChatComposerDraft";
import { useChatPendingInteractions } from "./useChatPendingInteractions";

interface ChatComposerEditingInput {
  threadId: ThreadId;
  promptRef: ReturnType<typeof useChatComposerDraft>["promptRef"];
  activePendingProgress: ReturnType<typeof useChatPendingInteractions>["activePendingProgress"];
  activePendingUserInputKey: ReturnType<
    typeof useChatPendingInteractions
  >["activePendingUserInputKey"];
  pendingUserInputAnswersByRequestIdRef: ReturnType<
    typeof useChatPendingInteractions
  >["pendingUserInputAnswersByRequestIdRef"];
  setPendingUserInputAnswersByRequestId: ReturnType<
    typeof useChatPendingInteractions
  >["setPendingUserInputAnswersByRequestId"];
  setPrompt: ReturnType<typeof useChatComposerDraft>["setPrompt"];
  setComposerCursor: ReturnType<typeof useChatComposerDraft>["setComposerCursor"];
  setComposerTrigger: ReturnType<typeof useChatComposerDraft>["setComposerTrigger"];
  composerEditorRef: ReturnType<typeof useChatComposerDraft>["composerEditorRef"];
  composerCursor: ReturnType<typeof useChatComposerDraft>["composerCursor"];
  composerTerminalContexts: ReturnType<typeof useChatComposerDraft>["composerTerminalContexts"];
  setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  setRestoredQueuedSourceProposedPlan: ReturnType<
    typeof useChatComposerDraft
  >["setRestoredQueuedSourceProposedPlan"];
  clearComposerDraftContent: ReturnType<typeof useChatComposerDraft>["clearComposerDraftContent"];
  scheduleComposerFocus: () => void;
}

export function useChatComposerEditing({
  threadId,
  promptRef,
  activePendingProgress,
  activePendingUserInputKey,
  pendingUserInputAnswersByRequestIdRef,
  setPendingUserInputAnswersByRequestId,
  setPrompt,
  setComposerCursor,
  setComposerTrigger,
  composerEditorRef,
  composerCursor,
  composerTerminalContexts,
  setComposerHighlightedItemId,
  setRestoredQueuedSourceProposedPlan,
  clearComposerDraftContent,
  scheduleComposerFocus,
}: ChatComposerEditingInput) {
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; cursorOffset?: number },
    ): number | false => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      let nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      // Apply cursor offset if specified (e.g., -1 to position inside parentheses)
      if (options?.cursorOffset !== undefined) {
        nextCursor = Math.max(0, nextCursor + options.cursorOffset);
      }
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInputKey) {
        const nextDraftAnswer = setPendingUserInputCustomAnswer(
          pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[
            activePendingQuestion.id
          ],
          next.text,
        );
        const nextRequestAnswers = {
          ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
          [activePendingQuestion.id]: nextDraftAnswer,
        };
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInputKey]: nextRequestAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInputKey]: nextRequestAnswers,
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return nextCursor;
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      composerEditorRef,
      activePendingProgress?.activeQuestion,
      activePendingUserInputKey,
      setPrompt,
      setPendingUserInputAnswersByRequestId,
      pendingUserInputAnswersByRequestIdRef,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    selectionCollapsed: boolean;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      selectionCollapsed: true,
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [promptRef, composerEditorRef, composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: {
      value: string;
      cursor: number;
      expandedCursor: number;
      selectionCollapsed: boolean;
    };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  // Shared insertion path for picker selections (mentions, plugins, skills,
  // agents, provider-native commands, local folders). Guarantees the replacement
  // is flanked by a leading space when landing next to a non-whitespace char and
  // absorbs an existing trailing space so we don't end up with double spaces.
  const applyComposerTriggerReplacement = useCallback(
    (params: {
      snapshot: { value: string };
      trigger: ComposerTrigger;
      base: string;
      cursorOffset?: number;
      onApplied?: () => void;
    }): number | false => {
      const { snapshot, trigger, base, cursorOffset, onApplied } = params;
      const replacement = ensureLeadingSpaceForReplacement(
        snapshot.value,
        trigger.rangeStart,
        base,
      );
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const options: { expectedText: string; cursorOffset?: number } = {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      };
      if (cursorOffset !== undefined) {
        options.cursorOffset = cursorOffset;
      }
      const applied = applyPromptReplacement(
        trigger.rangeStart,
        replacementRangeEnd,
        replacement,
        options,
      );
      if (applied !== false) {
        onApplied?.();
        setComposerHighlightedItemId(null);
      }
      return applied;
    },
    [setComposerHighlightedItemId, applyPromptReplacement],
  );

  // Replaces the active `@...` token with a completed absolute folder mention.
  const handleSelectLocalDirectoryMention = useCallback(
    (absolutePath: string) => {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      applyComposerTriggerReplacement({
        snapshot,
        trigger,
        base: `${formatComposerMentionToken(absolutePath)} `,
      });
    },
    [applyComposerTriggerReplacement, resolveActiveComposerTrigger],
  );

  // Rewrites the active `@...` mention to an absolute folder path with a trailing separator
  // so the local-folder picker stays open and the user can keep browsing by clicking or typing.
  // Paths that need quoting (spaces, parentheses, …) are written as an unclosed
  // `@"...` so detectComposerTrigger keeps matching while the user descends (#351).
  const handleNavigateLocalFolder = useCallback(
    (absolutePath: string) => {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      const separator = absolutePath.includes("\\") ? "\\" : "/";
      const withTrailingSeparator = absolutePath.endsWith(separator)
        ? absolutePath
        : `${absolutePath}${separator}`;
      const base = composerMentionPathNeedsQuoting(withTrailingSeparator)
        ? `@"${withTrailingSeparator}`
        : `@${withTrailingSeparator}`;
      applyComposerTriggerReplacement({ snapshot, trigger, base });
    },
    [applyComposerTriggerReplacement, resolveActiveComposerTrigger],
  );

  const setComposerPromptValue = useCallback(
    (nextPrompt: string) => {
      setRestoredQueuedSourceProposedPlan(threadId, null);
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      setComposerHighlightedItemId(null);
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      composerEditorRef,
      setComposerHighlightedItemId,
      setPrompt,
      setRestoredQueuedSourceProposedPlan,
      threadId,
    ],
  );

  const clearComposerSlashDraft = useCallback(() => {
    promptRef.current = "";
    setRestoredQueuedSourceProposedPlan(threadId, null);
    clearComposerDraftContent(threadId);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);
    scheduleComposerFocus();
  }, [
    promptRef,
    setComposerCursor,
    setComposerTrigger,
    setComposerHighlightedItemId,
    clearComposerDraftContent,
    scheduleComposerFocus,
    setRestoredQueuedSourceProposedPlan,
    threadId,
  ]);
  return {
    applyPromptReplacement,
    resolveActiveComposerTrigger,
    applyComposerTriggerReplacement,
    handleSelectLocalDirectoryMention,
    handleNavigateLocalFolder,
    setComposerPromptValue,
    clearComposerSlashDraft,
  };
}
