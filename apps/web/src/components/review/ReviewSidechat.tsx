import {
  type ModelSelection,
  type ProviderSkillDescriptor,
  type ProviderSkillReference,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEventHandler,
  type FormEvent,
  type ReactNode,
} from "react";

import { getAppModelOptions } from "~/appSettings";
import {
  splitPromptIntoComposerSegments,
  splitPromptIntoDisplaySegments,
} from "~/composer-editor-mentions";
import {
  deriveCompactChatTimelineEntries,
  deriveWorkLogEntries,
  type CompactChatTimelineEntry,
  type WorkLogEntry,
} from "~/session-logic";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import {
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "../chat/composerPickerStyles";
import {
  getChatTranscriptTextStyle,
  getChatTranscriptUserMessageTextStyle,
} from "../chat/chatTypography";
import { SimpleWorkEntryRow } from "../chat/workEntryRow";
import { UserMessageBody } from "../chat/userMessageBody";
import { useTheme } from "~/hooks/useTheme";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { AssistantMarkdownBody, UserMessageBubbleFrame } from "../chat/messagePrimitives";
import { ComposerSendArrowIcon, Loader2Icon, PlusIcon } from "~/lib/icons";
import { newMessageId, cn } from "~/lib/utils";
import { providerSkillsQueryOptions } from "~/lib/providerDiscoveryReactQuery";
import { toastManager } from "../ui/toast";
import {
  defaultReviewChatModelSelection,
  prewarmReviewChatThread,
  REVIEW_RISKS_NATIVE_REVIEW_QUESTION,
  sendReviewChatQuestion,
  startNewReviewChatThread,
} from "~/lib/reviewChatThread";
import { useStore } from "~/store";
import { createReviewSidechatThreadSelector } from "~/storeSelectors";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import type { ChatMessage, Thread } from "~/types";
import type { ReviewSidechatContextPayload } from "./reviewSidechatContext";

const ASK_SUGGESTIONS = [
  "Summarize this PR",
  "What should I review first?",
  "Explain the failing checks",
  REVIEW_RISKS_NATIVE_REVIEW_QUESTION,
] as const;

const noopComposerPaste: ClipboardEventHandler<HTMLElement> = () => {};
const emptyChatMessages: ChatMessage[] = [];
const emptyThreadActivities: NonNullable<Thread["activities"]> = [];
const emptyProviderSkills: ProviderSkillDescriptor[] = [];
const noopMessagesHandler = () => {};

type OptimisticReviewMessage = {
  message: ChatMessage;
  question: string;
};

type PendingReviewTurn = {
  question: string;
  startedAt: string;
  phase: "queued" | "provider-start-requested" | "sent";
};

const REVIEW_TURN_START_TIMEOUT_MS = 15_000;

type ReviewSidechatComposerProps = {
  compact: boolean;
  isReviewChatWorking: boolean;
  isSkillDiscoveryPending: boolean;
  isStartingSidechat: boolean;
  modelOptionsByProvider: Record<ProviderKind, ReturnType<typeof getAppModelOptions>>;
  selectedModelSelection: ModelSelection;
  showSuggestions: boolean;
  suggestions: readonly string[];
  onModelSelectionChange: (modelSelection: ModelSelection) => void;
  onDraftSkillMentionChange: (hasSkillMention: boolean) => void;
  onResolveSkillsForQuestion: (question: string) => Promise<readonly ProviderSkillReference[]>;
  onSendQuestion: (
    question: string,
    skills: readonly ProviderSkillReference[],
    optimisticMessage: OptimisticReviewMessage,
  ) => Promise<boolean>;
};

function reviewSidechatPrewarmKey(input: {
  context: ReviewSidechatContextPayload;
  modelSelection: ModelSelection;
}): string {
  const contextState =
    input.context.cwd !== null &&
    input.context.repositoryId !== null &&
    input.context.target !== null &&
    input.context.headSha !== null &&
    input.context.files.length > 0
      ? `head:${input.context.headSha}`
      : "incomplete";
  return [
    input.context.cwd ?? "",
    input.context.repositoryId ?? "",
    input.context.reference,
    String(input.context.number),
    contextState,
    input.modelSelection.provider,
    input.modelSelection.model,
    JSON.stringify(input.modelSelection.options ?? null),
  ].join("\u001f");
}

function displayReviewUserQuestion(text: string): string {
  const marker = "\nUser question:\n";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex === -1) {
    return text;
  }
  return text.slice(markerIndex + marker.length).trim();
}

function buildReviewModelOptionsByProvider(
  selectedModelSelection: ModelSelection,
): Record<ProviderKind, ReturnType<typeof getAppModelOptions>> {
  return {
    codex: getAppModelOptions(
      "codex",
      [],
      selectedModelSelection.provider === "codex" ? selectedModelSelection.model : null,
    ),
    claudeAgent: getAppModelOptions(
      "claudeAgent",
      [],
      selectedModelSelection.provider === "claudeAgent" ? selectedModelSelection.model : null,
    ),
    cursor: getAppModelOptions(
      "cursor",
      [],
      selectedModelSelection.provider === "cursor" ? selectedModelSelection.model : null,
    ),
    gemini: getAppModelOptions(
      "gemini",
      [],
      selectedModelSelection.provider === "gemini" ? selectedModelSelection.model : null,
    ),
    grok: getAppModelOptions(
      "grok",
      [],
      selectedModelSelection.provider === "grok" ? selectedModelSelection.model : null,
    ),
    kilo: getAppModelOptions(
      "kilo",
      [],
      selectedModelSelection.provider === "kilo" ? selectedModelSelection.model : null,
    ),
    opencode: getAppModelOptions(
      "opencode",
      [],
      selectedModelSelection.provider === "opencode" ? selectedModelSelection.model : null,
    ),
    pi: getAppModelOptions(
      "pi",
      [],
      selectedModelSelection.provider === "pi" ? selectedModelSelection.model : null,
    ),
  };
}

function normalizeSkillName(name: string): string {
  return name.toLowerCase();
}

function promptHasDisplaySkillMention(prompt: string): boolean {
  return splitPromptIntoDisplaySegments(prompt).some((segment) => segment.type === "skill");
}

function resolveReviewChatSkills(input: {
  prompt: string;
  availableSkills: readonly ProviderSkillDescriptor[];
}): ProviderSkillReference[] {
  const skillNames = new Set(
    splitPromptIntoComposerSegments(input.prompt)
      .filter((segment) => segment.type === "skill")
      .map((segment) => normalizeSkillName(segment.name)),
  );
  if (skillNames.size === 0) {
    return [];
  }

  const resolvedSkills: ProviderSkillReference[] = [];
  const seenSkillKeys = new Set<string>();
  for (const skill of input.availableSkills) {
    if (!skill.enabled || !skillNames.has(normalizeSkillName(skill.name))) {
      continue;
    }
    const skillKey = `${skill.name}\u001f${skill.path}`;
    if (seenSkillKeys.has(skillKey)) {
      continue;
    }
    seenSkillKeys.add(skillKey);
    resolvedSkills.push({ name: skill.name, path: skill.path });
  }
  return resolvedSkills;
}

function buildOptimisticReviewMessage(question: string): OptimisticReviewMessage {
  const createdAt = new Date().toISOString();
  return {
    question,
    message: {
      id: newMessageId(),
      role: "user",
      text: question,
      attachments: [],
      dispatchMode: "queue",
      turnId: null,
      createdAt,
      streaming: false,
      source: "native",
    },
  };
}

function deriveVisibleReviewMessages(messages: readonly ChatMessage[]): {
  readonly messages: ChatMessage[];
  readonly hasHiddenBootstrapMessage: boolean;
} {
  const visibleMessages: ChatMessage[] = [];
  let hideNextReadyAssistant = false;
  let hasHiddenBootstrapMessage = false;
  for (const message of messages) {
    if (message.source === "review-context-bootstrap") {
      hasHiddenBootstrapMessage = true;
      hideNextReadyAssistant = true;
      continue;
    }
    if (hideNextReadyAssistant && message.role === "assistant") {
      hideNextReadyAssistant = false;
      if (message.text.trim().toLowerCase() === "ready") {
        continue;
      }
    }
    visibleMessages.push(
      message.role === "user" && message.text.includes("\nUser question:\n")
        ? { ...message, text: displayReviewUserQuestion(message.text) }
        : message,
    );
  }
  return { messages: visibleMessages, hasHiddenBootstrapMessage };
}

type PendingAgentStatus = "starting" | "reading" | "thinking";

function formatPendingAgentStatus(status: PendingAgentStatus): string {
  switch (status) {
    case "starting":
      return "Starting review agent...";
    case "reading":
      return "Reading PR context...";
    case "thinking":
      return "Thinking...";
  }
}

type ReviewSidechatTimelineProps = {
  entries: readonly CompactChatTimelineEntry[];
  workEntries: readonly WorkLogEntry[];
  isWorking: boolean;
  activeTurnInProgress: boolean;
  pendingAgentStatus: PendingAgentStatus | null;
  markdownCwd: string | undefined;
};

// The sidebar runs a deliberately compact transcript independent of the app chat
// font setting, so it pins its own sizes rather than reading user preferences.
const REVIEW_SIDECHAT_TEXT_FONT_SIZE_PX = 12;
const REVIEW_SIDECHAT_META_FONT_SIZE_PX = 11;
const reviewSidechatAssistantTextStyle = getChatTranscriptTextStyle(
  REVIEW_SIDECHAT_TEXT_FONT_SIZE_PX,
);
const reviewSidechatUserMessageTextStyle = getChatTranscriptUserMessageTextStyle(
  REVIEW_SIDECHAT_TEXT_FONT_SIZE_PX,
);

const ReviewSidechatTimeline = memo(function ReviewSidechatTimeline({
  entries,
  workEntries,
  isWorking,
  activeTurnInProgress,
  pendingAgentStatus,
  markdownCwd,
}: ReviewSidechatTimelineProps) {
  const { resolvedTheme } = useTheme();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastEntryId = entries.at(-1)?.id ?? null;
  const lastWorkEntryId = workEntries.at(-1)?.id ?? null;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [activeTurnInProgress, isWorking, lastEntryId, lastWorkEntryId, pendingAgentStatus]);

  if (entries.length === 0 && !isWorking) {
    return (
      <PanelStateMessage density="compact" fill="flex" className="px-4">
        Ask about changes, checks, risk, or what to read first.
      </PanelStateMessage>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3.5 contain-content"
      role="log"
      aria-live={activeTurnInProgress ? "polite" : "off"}
      aria-label="PR chat messages"
    >
      {entries.map((entry) => {
        if (entry.kind === "work") {
          return (
            <div key={entry.id} className="min-w-0">
              <SimpleWorkEntryRow
                workEntry={entry.entry}
                chatMetaFontSizePx={REVIEW_SIDECHAT_META_FONT_SIZE_PX}
                textFontSizePx={REVIEW_SIDECHAT_TEXT_FONT_SIZE_PX}
                density="compact"
              />
            </div>
          );
        }

        const message = entry.message;
        if (message.role === "user") {
          return (
            <div key={message.id} className="flex w-full justify-end">
              <UserMessageBubbleFrame className="max-w-[88%]">
                <UserMessageBody
                  text={message.text}
                  terminalContexts={[]}
                  chatTypographyStyle={reviewSidechatUserMessageTextStyle}
                  resolvedTheme={resolvedTheme}
                />
              </UserMessageBubbleFrame>
            </div>
          );
        }

        return (
          <div key={message.id} className="min-w-0">
            <AssistantMarkdownBody
              text={message.text}
              cwd={markdownCwd}
              isStreaming={message.streaming}
              className="prose-p:my-1.5 prose-pre:my-2 prose-ul:my-1.5 prose-ol:my-1.5"
              style={reviewSidechatAssistantTextStyle}
            />
          </div>
        );
      })}
      {pendingAgentStatus !== null ? (
        <div
          className="flex items-center gap-2 px-1 py-1 text-muted-foreground"
          style={reviewSidechatAssistantTextStyle}
        >
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          <span>{formatPendingAgentStatus(pendingAgentStatus)}</span>
        </div>
      ) : null}
    </div>
  );
});

const ReviewSidechatComposer = memo(function ReviewSidechatComposer({
  compact,
  isReviewChatWorking,
  isSkillDiscoveryPending,
  isStartingSidechat,
  modelOptionsByProvider,
  selectedModelSelection,
  showSuggestions,
  suggestions,
  onModelSelectionChange,
  onDraftSkillMentionChange,
  onResolveSkillsForQuestion,
  onSendQuestion,
}: ReviewSidechatComposerProps) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [isResolvingSkills, setIsResolvingSkills] = useState(false);
  const hasPrompt = draft.trim().length > 0;
  const isSendBlocked = isReviewChatWorking || isSkillDiscoveryPending || isResolvingSkills;
  const sendDraft = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (question.length === 0 || isSendBlocked) {
        return;
      }
      const previousDraft = draft;
      setIsResolvingSkills(true);
      try {
        const skills = await onResolveSkillsForQuestion(question);
        const nextOptimisticMessage = buildOptimisticReviewMessage(question);
        setDraft("");
        setCursor(0);
        onDraftSkillMentionChange(false);
        const sent = await onSendQuestion(question, skills, nextOptimisticMessage);
        if (!sent) {
          setDraft(previousDraft);
          setCursor(previousDraft.length);
          onDraftSkillMentionChange(promptHasDisplaySkillMention(previousDraft));
        }
      } finally {
        setIsResolvingSkills(false);
      }
    },
    [
      draft,
      isSendBlocked,
      onDraftSkillMentionChange,
      onResolveSkillsForQuestion,
      onSendQuestion,
    ],
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!isSendBlocked) {
        void sendDraft(draft);
      }
    },
    [draft, isSendBlocked, sendDraft],
  );
  const handleComposerCommandKey = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash", event: KeyboardEvent): boolean => {
      if (key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!isSendBlocked) {
          void sendDraft(draft);
        }
        return true;
      }
      return false;
    },
    [draft, isSendBlocked, sendDraft],
  );
  const handleDraftChange = useCallback(
    (nextValue: string, nextCursor: number) => {
      setDraft(nextValue);
      setCursor(nextCursor);
      onDraftSkillMentionChange(promptHasDisplaySkillMention(nextValue));
    },
    [onDraftSkillMentionChange],
  );

  return (
    <form
      className={cn(
        "group/ask mt-auto flex shrink-0 flex-col gap-2.5 px-3.5 py-3.5",
        "border-t border-border/25 bg-background/80",
      )}
      onSubmit={handleSubmit}
    >
      {showSuggestions ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={isSendBlocked}
              className={cn(
                "rounded-full border border-border/35 bg-muted/20 text-muted-foreground transition-[background-color,color,border-color] duration-150 hover:border-border/60 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                "disabled:pointer-events-none disabled:opacity-45",
                "px-2.5 py-1 text-[11px]",
              )}
              onClick={() => void sendDraft(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <div className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, "rounded-3xl")}>
        <div className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden rounded-3xl")}>
          <div className={cn(COMPOSER_EDITOR_PADDING_CLASS_NAME, "pt-3 pb-3.5")}>
            <ComposerPromptEditor
              value={draft}
              cursor={cursor}
              terminalContexts={[]}
              disabled={isStartingSidechat || isResolvingSkills}
              placeholder="Ask about this review"
              ariaLabel="Ask about this pull request"
              onRemoveTerminalContext={noopMessagesHandler}
              onChange={handleDraftChange}
              onCommandKeyDown={handleComposerCommandKey}
              onPaste={noopComposerPaste}
              className={cn("max-h-24 overflow-y-auto text-foreground", compact && "max-h-16")}
            />
          </div>
          <div className={COMPOSER_FOOTER_ROW_CLASS_NAME}>
            <ProviderModelPicker
              provider={selectedModelSelection.provider}
              model={selectedModelSelection.model}
              lockedProvider={selectedModelSelection.provider}
              modelOptionsByProvider={modelOptionsByProvider}
              compact
              disabled={isReviewChatWorking}
              onProviderModelChange={(provider, model) => {
                onModelSelectionChange({ provider, model });
              }}
            />
            <button
              type="submit"
              disabled={!hasPrompt || isSendBlocked}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background opacity-95 transition-[opacity,transform] hover:scale-[1.03] hover:opacity-100 disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              aria-label={isStartingSidechat ? "Starting PR chat" : "Send PR chat question"}
            >
              {isStartingSidechat || isResolvingSkills ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ComposerSendArrowIcon className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
});

export function ReviewSidechat(props: {
  context: ReviewSidechatContextPayload;
  mode: "conversation" | "files";
  cwd?: string | undefined;
  hostThreadId?: ThreadId | null;
  reviewThreadId?: ThreadId | null;
  ownsPrewarm?: boolean | undefined;
  header?: ReactNode;
  bodyAfterMessages?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [isStartingSidechat, setIsStartingSidechat] = useState(false);
  const [isStartingNewThread, setIsStartingNewThread] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticReviewMessage | null>(null);
  const [pendingReviewTurn, setPendingReviewTurn] = useState<PendingReviewTurn | null>(null);
  const [openedSidechatThreadId, setOpenedSidechatThreadId] = useState<ThreadId | null>(null);
  const [draftHasSkillMention, setDraftHasSkillMention] = useState(false);
  const manualThreadIdRef = useRef<ThreadId | null>(null);
  const prewarmedKeyRef = useRef<string | null>(null);
  const prewarmingKeyRef = useRef<string | null>(null);
  const latestContextRef = useRef(props.context);
  const [selectedModelSelection, setSelectedModelSelection] = useState<ModelSelection>(() =>
    defaultReviewChatModelSelection(),
  );
  const compact = props.mode === "files";
  const suggestions = ASK_SUGGESTIONS;
  const activeThreadId = openedSidechatThreadId ?? props.reviewThreadId ?? null;
  const selectActiveThread = useMemo(
    () => createReviewSidechatThreadSelector(activeThreadId),
    [activeThreadId],
  );
  const activeThread = useStore(selectActiveThread);
  const activeMessages = activeThread?.messages ?? emptyChatMessages;
  const activeActivities = activeThread?.activities ?? emptyThreadActivities;
  const activeTurnState = activeThread?.latestTurn?.state ?? null;
  const activeTurnId = activeThread?.latestTurn?.turnId ?? undefined;
  const activeTurnStartedAt = activeThread?.latestTurn?.startedAt ?? null;
  const visibleReviewState = useMemo(
    () => deriveVisibleReviewMessages(activeMessages),
    [activeMessages],
  );
  const visibleMessages = visibleReviewState.messages;
  const activeTurnBelongsToPendingReviewTurn =
    pendingReviewTurn !== null &&
    activeTurnStartedAt !== null &&
    activeTurnStartedAt >= pendingReviewTurn.startedAt;
  const hasAssistantResponseAfterPendingTurn =
    pendingReviewTurn !== null &&
    visibleMessages.some(
      (message) => message.role === "assistant" && message.createdAt >= pendingReviewTurn.startedAt,
    );
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedModelSelection.provider,
      cwd: props.context.cwd,
      threadId: activeThreadId,
      enabled: props.context.cwd != null && draftHasSkillMention,
    }),
  );
  const availableSkills = draftHasSkillMention
    ? (providerSkillsQuery.data?.skills ?? emptyProviderSkills)
    : emptyProviderSkills;
  const isSkillDiscoveryPending =
    draftHasSkillMention && providerSkillsQuery.isLoading && availableSkills.length === 0;
  const displayMessages = useMemo(() => {
    const hasServerEcho =
      optimisticMessage !== null &&
      visibleMessages.some(
        (message) =>
          message.role === "user" &&
          displayReviewUserQuestion(message.text) === optimisticMessage.question,
      );
    const optimisticMessages: ChatMessage[] = [];
    if (optimisticMessage !== null && !hasServerEcho) {
      optimisticMessages.push(optimisticMessage.message);
    }
    if (optimisticMessages.length === 0) {
      return visibleMessages;
    }
    return [...visibleMessages, ...optimisticMessages];
  }, [optimisticMessage, visibleMessages]);
  const activeTurnActivities = useMemo(() => {
    const scopedActivities = activeTurnId
      ? activeActivities.filter(
          (activity) =>
            activity.turnId === activeTurnId ||
            (activity.kind === "reasoning.delta" && activity.turnId === null) ||
            (activity.kind === "context-compaction" && activity.turnId === null),
        )
      : activeActivities;
    if (pendingReviewTurn === null || activeTurnBelongsToPendingReviewTurn) {
      return scopedActivities;
    }
    return scopedActivities.filter(
      (activity) =>
        activity.createdAt >= pendingReviewTurn.startedAt || activity.kind === "context-compaction",
    );
  }, [activeActivities, activeTurnBelongsToPendingReviewTurn, activeTurnId, pendingReviewTurn]);
  const reviewWorkLogEntries = useMemo(
    () => deriveWorkLogEntries(activeTurnActivities, activeTurnId),
    [activeTurnActivities, activeTurnId],
  );
  const hasRuntimeOutputAfterPendingTurn =
    pendingReviewTurn !== null &&
    reviewWorkLogEntries.some((entry) => entry.createdAt >= pendingReviewTurn.startedAt);
  const hasVisibleProgressAfterPendingTurn =
    hasAssistantResponseAfterPendingTurn || hasRuntimeOutputAfterPendingTurn;
  const isPendingReviewTurn =
    pendingReviewTurn !== null &&
    !hasVisibleProgressAfterPendingTurn &&
    (!activeTurnBelongsToPendingReviewTurn ||
      (activeTurnState !== "error" && activeTurnState !== "interrupted"));
  const timelineEntries = useMemo(
    () => deriveCompactChatTimelineEntries(displayMessages, reviewWorkLogEntries),
    [displayMessages, reviewWorkLogEntries],
  );
  const hasHiddenBootstrapTurnInProgress =
    activeTurnState === "running" &&
    visibleMessages.length === 0 &&
    optimisticMessage === null &&
    (visibleReviewState.hasHiddenBootstrapMessage || reviewWorkLogEntries.length === 0);
  const isReviewChatWorking =
    isStartingSidechat ||
    isStartingNewThread ||
    (activeTurnState === "running" && !hasHiddenBootstrapTurnInProgress) ||
    isPendingReviewTurn;
  const pendingAgentStatus = useMemo((): PendingAgentStatus | null => {
    if (!isReviewChatWorking || hasAssistantResponseAfterPendingTurn) {
      return null;
    }
    const hasReasoningActivity = activeTurnActivities.some(
      (activity) =>
        activity.kind === "reasoning.delta" &&
        (pendingReviewTurn === null || activity.createdAt >= pendingReviewTurn.startedAt),
    );
    if (hasReasoningActivity) {
      return null;
    }
    if (hasRuntimeOutputAfterPendingTurn || reviewWorkLogEntries.length > 0) {
      return "reading";
    }
    if (isStartingNewThread || isStartingSidechat) {
      return "starting";
    }
    if (pendingReviewTurn !== null) {
      return pendingReviewTurn.phase === "sent" ||
        pendingReviewTurn.phase === "provider-start-requested" ||
        activeTurnBelongsToPendingReviewTurn
        ? "thinking"
        : "starting";
    }
    if (activeTurnState === "running" && !hasHiddenBootstrapTurnInProgress) {
      return "thinking";
    }
    return null;
  }, [
    activeTurnActivities,
    activeTurnState,
    hasAssistantResponseAfterPendingTurn,
    hasHiddenBootstrapTurnInProgress,
    hasRuntimeOutputAfterPendingTurn,
    isReviewChatWorking,
    isStartingNewThread,
    isStartingSidechat,
    activeTurnBelongsToPendingReviewTurn,
    pendingReviewTurn,
    reviewWorkLogEntries.length,
  ]);

  const modelOptionsByProvider = useMemo(
    () => buildReviewModelOptionsByProvider(selectedModelSelection),
    [selectedModelSelection],
  );
  const prewarmKey = useMemo(
    () =>
      reviewSidechatPrewarmKey({
        context: props.context,
        modelSelection: selectedModelSelection,
      }),
    [props.context, selectedModelSelection],
  );
  const handleDraftSkillMentionChange = useCallback((hasSkillMention: boolean) => {
    setDraftHasSkillMention(hasSkillMention);
  }, []);
  const resolveSkillsForQuestion = useCallback(
    async (question: string): Promise<readonly ProviderSkillReference[]> => {
      const skillNames = splitPromptIntoComposerSegments(question).filter(
        (segment) => segment.type === "skill",
      );
      if (skillNames.length === 0 || props.context.cwd === null) {
        return [];
      }
      try {
        const result = await queryClient.ensureQueryData(
          providerSkillsQueryOptions({
            provider: selectedModelSelection.provider,
            cwd: props.context.cwd,
            threadId: activeThreadId,
            enabled: true,
          }),
        );
        return resolveReviewChatSkills({
          prompt: question,
          availableSkills: result.skills,
        });
      } catch {
        return [];
      }
    },
    [activeThreadId, props.context.cwd, queryClient, selectedModelSelection.provider],
  );
  useEffect(() => {
    manualThreadIdRef.current = null;
    setOpenedSidechatThreadId(props.reviewThreadId ?? null);
  }, [props.context.number, props.context.reference, props.reviewThreadId]);

  useEffect(() => {
    latestContextRef.current = props.context;
  }, [props.context]);

  useEffect(() => {
    if (props.ownsPrewarm === false) {
      return;
    }
    if (!latestContextRef.current.cwd) {
      return;
    }
    if (prewarmedKeyRef.current === prewarmKey || prewarmingKeyRef.current === prewarmKey) {
      return;
    }
    prewarmingKeyRef.current = prewarmKey;
    let cancelled = false;
    void prewarmReviewChatThread({
      payload: latestContextRef.current,
      modelSelection: selectedModelSelection,
      onThreadReady: (threadId) => {
        if (!cancelled && manualThreadIdRef.current === null) {
          setOpenedSidechatThreadId(threadId);
        }
      },
    })
      .then((result) => {
        if (result.status === "ready") {
          prewarmedKeyRef.current = prewarmKey;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (prewarmingKeyRef.current === prewarmKey) {
          prewarmingKeyRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [prewarmKey, props.ownsPrewarm, selectedModelSelection]);

  useEffect(() => {
    if (!activeThreadId) {
      return undefined;
    }
    return retainThreadDetailSubscription(activeThreadId);
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThread?.modelSelection) {
      return;
    }
    setSelectedModelSelection(activeThread.modelSelection);
  }, [activeThread?.modelSelection, activeThreadId]);

  useEffect(() => {
    if (!optimisticMessage) {
      return;
    }
    const hasServerEcho = activeMessages.some(
      (message) =>
        message.role === "user" &&
        displayReviewUserQuestion(message.text) === optimisticMessage.question,
    );
    if (hasServerEcho) {
      setOptimisticMessage(null);
    }
  }, [activeMessages, optimisticMessage]);

  useEffect(() => {
    if (!pendingReviewTurn) {
      return;
    }
    if (
      (activeTurnBelongsToPendingReviewTurn &&
        (activeTurnState === "completed" ||
          activeTurnState === "error" ||
          activeTurnState === "interrupted")) ||
      hasVisibleProgressAfterPendingTurn
    ) {
      setPendingReviewTurn(null);
    }
  }, [
    activeTurnBelongsToPendingReviewTurn,
    activeTurnState,
    hasVisibleProgressAfterPendingTurn,
    pendingReviewTurn,
  ]);

  useEffect(() => {
    if (
      !pendingReviewTurn ||
      pendingReviewTurn.phase === "queued" ||
      activeTurnBelongsToPendingReviewTurn ||
      hasVisibleProgressAfterPendingTurn
    ) {
      return;
    }
    const pendingStartedAt = pendingReviewTurn.startedAt;
    const timeout = window.setTimeout(() => {
      setPendingReviewTurn((current) => {
        if (current?.startedAt !== pendingStartedAt) {
          return current;
        }
        return null;
      });
      setOptimisticMessage(null);
      toastManager.add({
        type: "error",
        title: "PR chat did not start",
        description: "The review message was accepted, but no agent turn started.",
      });
    }, REVIEW_TURN_START_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [activeTurnBelongsToPendingReviewTurn, hasVisibleProgressAfterPendingTurn, pendingReviewTurn]);

  const sendQuestion = useCallback(
    async (
      question: string,
      skills: readonly ProviderSkillReference[],
      nextOptimisticMessage: OptimisticReviewMessage,
    ): Promise<boolean> => {
      setIsStartingSidechat(true);
      setOptimisticMessage(nextOptimisticMessage);
      setPendingReviewTurn(null);
      try {
        const result = await sendReviewChatQuestion({
          payload: latestContextRef.current,
          question,
          ...(activeThreadId ? { threadId: activeThreadId } : {}),
          modelSelection: selectedModelSelection,
          skills,
          onThreadReady: (threadId) => {
            setOpenedSidechatThreadId(threadId);
          },
          onQueuedProviderStartRequested: (threadId, startedAt) => {
            setOpenedSidechatThreadId(threadId);
            setPendingReviewTurn((current) =>
              current?.startedAt === startedAt
                ? { ...current, phase: "provider-start-requested" }
                : current,
            );
          },
          onQueuedTurnStarted: (threadId, startedAt) => {
            setOpenedSidechatThreadId(threadId);
            setPendingReviewTurn((current) =>
              current?.startedAt === startedAt ? { ...current, phase: "sent" } : current,
            );
          },
          onQueuedTurnFailed: (_threadId, queuedAt, reason) => {
            setPendingReviewTurn((current) => (current?.startedAt === queuedAt ? null : current));
            setOptimisticMessage(null);
            toastManager.add({
              type: "error",
              title: "Could not send PR chat message",
              description: reason,
            });
          },
        });
        if (result.status === "sent" || result.status === "queued") {
          setOpenedSidechatThreadId(result.threadId);
          setPendingReviewTurn({
            question,
            startedAt: result.status === "sent" ? result.turnRequestedAt : result.queuedAt,
            phase: result.status,
          });
          return true;
        }
        setOptimisticMessage(null);
        setPendingReviewTurn(null);
        toastManager.add({
          type: "warning",
          title: "PR chat is unavailable",
          description: result.reason,
        });
        return false;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not send PR chat message",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while sending the PR chat message.",
        });
        setOptimisticMessage(null);
        setPendingReviewTurn(null);
        return false;
      } finally {
        setIsStartingSidechat(false);
      }
    },
    [activeThreadId, selectedModelSelection],
  );

  const startFreshThread = async () => {
    if (isStartingNewThread) {
      return;
    }
    setIsStartingNewThread(true);
    setOptimisticMessage(null);
    setPendingReviewTurn(null);
    try {
      const result = await startNewReviewChatThread({
        payload: latestContextRef.current,
        modelSelection: selectedModelSelection,
      });
      if (result.status === "ready") {
        manualThreadIdRef.current = result.threadId;
        setOpenedSidechatThreadId(result.threadId);
        return;
      }
      toastManager.add({
        type: "warning",
        title: "Could not start PR chat",
        description: result.reason,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start PR chat",
        description:
          error instanceof Error ? error.message : "An error occurred while starting the PR chat.",
      });
    } finally {
      setIsStartingNewThread(false);
    }
  };

  return (
    <section
      className={cn("flex min-h-0 flex-col bg-background", compact ? "flex-1" : "min-h-0 flex-1")}
    >
      {props.header ? (
        <div className="relative shrink-0">
          {props.header}
          <button
            type="button"
            aria-label="Start new PR chat thread"
            title="Start new PR chat thread"
            disabled={isStartingNewThread}
            onClick={() => void startFreshThread()}
            className={cn(
              "absolute top-3 right-12 inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground outline-none",
              "transition-[background-color,color,opacity,transform] duration-150 hover:bg-muted/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              "disabled:pointer-events-none disabled:opacity-40",
            )}
          >
            {isStartingNewThread ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <PlusIcon className="size-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-hidden",
          props.bodyAfterMessages && !activeThreadId && !optimisticMessage ? "shrink-0" : "flex-1",
        )}
      >
        {activeThreadId || optimisticMessage ? (
          <ReviewSidechatTimeline
            entries={timelineEntries}
            workEntries={reviewWorkLogEntries}
            isWorking={isReviewChatWorking}
            activeTurnInProgress={
              activeTurnState === "running" && !hasHiddenBootstrapTurnInProgress
            }
            pendingAgentStatus={pendingAgentStatus}
            markdownCwd={props.context.cwd ?? undefined}
          />
        ) : (
          <PanelStateMessage density="compact" fill="flex" className="px-4 text-left">
            Ask about #{props.context.number}: what changed, where to start, checks, or risk.
          </PanelStateMessage>
        )}
      </div>
      {props.bodyAfterMessages ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{props.bodyAfterMessages}</div>
      ) : null}
      <ReviewSidechatComposer
        compact={compact}
        isReviewChatWorking={isReviewChatWorking}
        isSkillDiscoveryPending={isSkillDiscoveryPending}
        isStartingSidechat={isStartingSidechat}
        modelOptionsByProvider={modelOptionsByProvider}
        selectedModelSelection={selectedModelSelection}
        showSuggestions={visibleMessages.length === 0 && optimisticMessage === null}
        suggestions={suggestions}
        onDraftSkillMentionChange={handleDraftSkillMentionChange}
        onModelSelectionChange={setSelectedModelSelection}
        onResolveSkillsForQuestion={resolveSkillsForQuestion}
        onSendQuestion={sendQuestion}
      />
    </section>
  );
}
