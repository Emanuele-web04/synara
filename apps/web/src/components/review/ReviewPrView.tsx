import type {
  ReviewCheck,
  ReviewSourceRef,
  ReviewTimelineEvent,
  ThreadId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  reviewLoadChangesetQueryOptions,
  reviewLoadConversationQueryOptions,
  reviewLoadPullRequestQueryOptions,
} from "~/lib/reviewReactQuery";
import {
  buildReviewChatTarget,
  defaultReviewChatModelSelection,
  findProjectForReviewChat,
  prewarmReviewChatThread,
} from "~/lib/reviewChatThread";
import { rpcErrorMessage } from "~/lib/rpcErrorMessage";
import { ArrowLeftIcon, GitPullRequestIcon } from "~/lib/icons";
import { useStore } from "~/store";
import { createReviewChatThreadIdSelector } from "~/storeSelectors";
import { Button } from "../ui/button";
import { ReviewConversation } from "./ReviewConversation";
import { ReviewPrHeader } from "./ReviewPrHeader";
import {
  ReviewOverviewSkeleton,
  ReviewPrHeaderSkeleton,
  ReviewPrSidebarSkeleton,
} from "./ReviewPrSkeleton";
import { ReviewPrSidebar } from "./ReviewPrSidebar";
import { ReviewSubmitBar } from "./ReviewSubmitBar";
import { ReviewSurface } from "./ReviewSurface";
import { EmptyState } from "./reviewPrimitives";
import { buildReviewSidechatContextPayload } from "./reviewSidechatContext";
import type { ReviewSidechatContextPayload } from "./reviewSidechatContext";

type PrTab = "conversation" | "files";

const EMPTY_CHECKS: ReadonlyArray<ReviewCheck> = [];
const EMPTY_EVENTS: ReadonlyArray<ReviewTimelineEvent> = [];

function reviewSourceKey(source: ReviewSourceRef): string {
  if (source._tag === "pullRequest") {
    return `pullRequest:${source.reference}`;
  }
  return `branchRange:${source.base}:${source.head}`;
}

function Centered(props: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-center text-[12px] text-muted-foreground">
      {props.children}
    </div>
  );
}

const REVIEW_OVERVIEW_COLUMN_CLASS_NAME =
  "mx-auto flex w-full max-w-[58rem] flex-col px-5 sm:px-7 2xl:max-w-[64rem]";
const REVIEW_SIDEBAR_COLLAPSED_STORAGE_KEY = "review:ask-devin-sidebar-collapsed";

function initialSidebarCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(REVIEW_SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

function saveSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(REVIEW_SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Persisting sidebar chrome preferences is best-effort.
  }
}

function reviewChatPrewarmContextKey(
  context: Pick<
    ReviewSidechatContextPayload,
    "cwd" | "repositoryId" | "reference" | "number" | "headSha" | "target" | "files"
  >,
): string {
  const contextState =
    context.cwd !== null &&
    context.repositoryId !== null &&
    context.target !== null &&
    context.headSha !== null &&
    context.files.length > 0
      ? `head:${context.headSha}`
      : "incomplete";
  return [
    context.cwd ?? "",
    context.repositoryId ?? "",
    context.reference,
    String(context.number),
    contextState,
  ].join("\u001f");
}

export function ReviewPrView(props: {
  cwd: string | null;
  reference: string;
  source: ReviewSourceRef;
  hostThreadId?: ThreadId | null;
}) {
  const [tab, setTab] = useState<PrTab>("conversation");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const projects = useStore((state) => state.projects);
  const prewarmedReviewChatKeyRef = useRef<string | null>(null);
  const latestSidechatContextRef = useRef<ReviewSidechatContextPayload | null>(null);
  const sourceKey = reviewSourceKey(props.source);
  useEffect(() => {
    setTab("conversation");
    setSelectedFilePath(null);
  }, [props.reference, sourceKey]);
  const overviewQuery = useQuery(
    reviewLoadPullRequestQueryOptions({ cwd: props.cwd, reference: props.reference }),
  );
  const conversationQuery = useQuery(
    reviewLoadConversationQueryOptions({
      cwd: props.cwd,
      reference: overviewQuery.data?.detail ? props.reference : null,
    }),
  );
  const detail = overviewQuery.data?.detail ?? null;
  const changesetQuery = useQuery({
    ...reviewLoadChangesetQueryOptions({
      cwd: props.cwd,
      source: props.source,
    }),
    enabled: detail !== null && props.cwd !== null,
  });
  const checks = overviewQuery.data?.checks ?? EMPTY_CHECKS;
  const events = conversationQuery.data?.events ?? EMPTY_EVENTS;
  const sidechatContext = useMemo(() => {
    if (!detail) {
      return null;
    }
    return buildReviewSidechatContextPayload({
      cwd: props.cwd,
      reference: props.reference,
      detail,
      checks,
      events,
      files: changesetQuery.data?.files ?? [],
      source: props.source,
      target: changesetQuery.data?.target ?? null,
      headSha: changesetQuery.data?.headSha ?? null,
      currentView: tab,
      selectedFilePath,
    });
  }, [
    changesetQuery.data?.files,
    changesetQuery.data?.headSha,
    changesetQuery.data?.target,
    checks,
    detail,
    events,
    props.cwd,
    props.reference,
    props.source,
    selectedFilePath,
    tab,
  ]);
  const reviewChatTarget = useMemo(() => {
    if (!sidechatContext) {
      return null;
    }
    const project = findProjectForReviewChat(projects, sidechatContext.cwd);
    if (!project) {
      return null;
    }
    const target = buildReviewChatTarget(sidechatContext, project.id);
    if (!target) {
      return null;
    }
    return target;
  }, [projects, sidechatContext]);
  const selectReviewChatThreadId = useMemo(
    () => createReviewChatThreadIdSelector(reviewChatTarget),
    [reviewChatTarget],
  );
  const reviewChatThreadId = useStore(selectReviewChatThreadId);
  const reviewChatPrewarmKey = useMemo(() => {
    if (!sidechatContext?.cwd) {
      return null;
    }
    const modelSelection = defaultReviewChatModelSelection();
    return [
      reviewChatPrewarmContextKey(sidechatContext),
      modelSelection.provider,
      modelSelection.model,
      JSON.stringify(modelSelection.options ?? null),
    ].join("\u001f");
  }, [sidechatContext]);
  useEffect(() => {
    latestSidechatContextRef.current = sidechatContext;
  }, [sidechatContext]);
  useEffect(() => {
    const sidechatContext = latestSidechatContextRef.current;
    if (!sidechatContext?.cwd || !reviewChatPrewarmKey) {
      return;
    }
    const modelSelection = defaultReviewChatModelSelection();
    if (prewarmedReviewChatKeyRef.current === reviewChatPrewarmKey) {
      return;
    }
    prewarmedReviewChatKeyRef.current = reviewChatPrewarmKey;
    void prewarmReviewChatThread({
      payload: sidechatContext,
      modelSelection,
    }).catch(() => undefined);
  }, [reviewChatPrewarmKey]);
  const reviewAction =
    tab === "files" ? (
      <ReviewSubmitBar
        mode="header"
        cwd={props.cwd}
        reference={props.reference}
        target={changesetQuery.data?.target ?? null}
        expectedHeadSha={changesetQuery.data?.headSha ?? null}
      />
    ) : undefined;
  const navigationAction =
    tab === "files" ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 shrink-0 rounded-lg px-2.5 text-[12px]"
        title="Back to pull request overview"
        aria-label="Back to pull request overview"
        onClick={() => setTab("conversation")}
      >
        <ArrowLeftIcon className="size-3.5" />
        <span className="hidden lg:inline">Overview</span>
      </Button>
    ) : undefined;
  const updateSidebarCollapsed = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    saveSidebarCollapsed(collapsed);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        {detail ? (
          <div className="flex h-full min-h-0 min-w-0 flex-1">
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
              {tab === "files" ? (
                <main className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
                  <ReviewSurface
                    mode="page"
                    cwd={props.cwd}
                    source={props.source}
                    selectedFilePath={selectedFilePath}
                    onSelectedFilePathChange={setSelectedFilePath}
                    reviewAction={reviewAction}
                    navigationAction={navigationAction}
                    changesetState={changesetQuery}
                  />
                </main>
              ) : (
                <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                  <ReviewPrHeader
                    detail={detail}
                    variant="full"
                    reviewMode={tab}
                    contentClassName={REVIEW_OVERVIEW_COLUMN_CLASS_NAME}
                    onReviewChanges={() => setTab("files")}
                    onOverview={() => setTab("conversation")}
                  />
                  <ReviewConversation
                    detail={detail}
                    cwd={props.cwd}
                    reference={props.reference}
                    events={conversationQuery.data?.events ?? []}
                    isLoading={conversationQuery.isLoading}
                    className={REVIEW_OVERVIEW_COLUMN_CLASS_NAME}
                  />
                </main>
              )}
            </div>
            {sidechatContext ? (
              <ReviewPrSidebar
                detail={detail}
                checks={checks}
                events={events}
                mode={tab}
                cwd={props.cwd}
                source={props.source}
                target={changesetQuery.data?.target ?? null}
                sidechatContext={sidechatContext}
                hostThreadId={props.hostThreadId ?? null}
                reviewThreadId={reviewChatThreadId}
                sidechatOwnsPrewarm={false}
                collapsed={sidebarCollapsed}
                onCollapsedChange={updateSidebarCollapsed}
              />
            ) : null}
          </div>
        ) : overviewQuery.isLoading ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="shrink-0">
              <ReviewPrHeaderSkeleton />
            </div>
            <div className="flex min-h-0 min-w-0 flex-1">
              <div className="min-w-0 flex-1 overflow-y-auto">
                <ReviewOverviewSkeleton />
              </div>
              <ReviewPrSidebarSkeleton />
            </div>
          </div>
        ) : overviewQuery.isError ? (
          <div className="min-w-0 flex-1 overflow-y-auto">
            <EmptyState icon={<GitPullRequestIcon />} title="Unavailable">
              {rpcErrorMessage(overviewQuery.error) ?? "Could not load this pull request."}
            </EmptyState>
          </div>
        ) : (
          <div className="min-w-0 flex-1 overflow-y-auto">
            <Centered>No pull request data.</Centered>
          </div>
        )}
      </div>
    </div>
  );
}
