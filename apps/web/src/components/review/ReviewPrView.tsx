import type {
  ReviewCheck,
  ReviewSourceRef,
  ReviewTimelineEvent,
  ThreadId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  reviewLoadConversationQueryOptions,
  reviewLoadPullRequestHeaderQueryOptions,
  reviewLoadPullRequestSurfaceQueryOptions,
  reviewSourceKey,
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

function reviewConversationHydrationKey(input: {
  readonly cwd: string | null;
  readonly reference: string;
  readonly sourceKey: string;
}): string | null {
  if (input.cwd === null) {
    return null;
  }
  return [input.cwd, input.reference, input.sourceKey].join("\u001f");
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
  const queryClient = useQueryClient();
  const projects = useStore((state) => state.projects);
  const prewarmedReviewChatKeyRef = useRef<string | null>(null);
  const prewarmingReviewChatKeyRef = useRef<string | null>(null);
  const latestSidechatContextRef = useRef<ReviewSidechatContextPayload | null>(null);
  const sourceKey = reviewSourceKey(props.source);
  const conversationHydrationKey = reviewConversationHydrationKey({
    cwd: props.cwd,
    reference: props.reference,
    sourceKey,
  });
  useEffect(() => {
    setTab("conversation");
    setSelectedFilePath(null);
  }, [props.reference, sourceKey]);
  const [readySurfaceHydrationKey, setReadySurfaceHydrationKey] = useState<string | null>(null);
  useEffect(() => {
    setReadySurfaceHydrationKey(null);
  }, [conversationHydrationKey]);
  const headerQuery = useQuery({
    ...reviewLoadPullRequestHeaderQueryOptions({ cwd: props.cwd, reference: props.reference }),
    enabled: props.cwd !== null,
  });
  const headerDetail = headerQuery.data?.detail ?? null;
  useEffect(() => {
    if (conversationHydrationKey === null || headerDetail === null) {
      setReadySurfaceHydrationKey(null);
      return;
    }
    const frame = window.requestAnimationFrame(() =>
      setReadySurfaceHydrationKey(conversationHydrationKey),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [conversationHydrationKey, headerDetail]);
  const isSurfaceHydrationReady =
    readySurfaceHydrationKey !== null && readySurfaceHydrationKey === conversationHydrationKey;
  const surfaceQuery = useQuery({
    ...reviewLoadPullRequestSurfaceQueryOptions({
      cwd: props.cwd,
      reference: headerDetail ? props.reference : null,
      source: props.source,
      includeConversation: false,
      includeChangeset: tab === "files",
      queryClient,
    }),
    enabled:
      props.cwd !== null && headerDetail !== null && isSurfaceHydrationReady && tab === "files",
  });
  const conversationQuery = useQuery({
    ...reviewLoadConversationQueryOptions({
      cwd: props.cwd,
      reference: headerDetail ? props.reference : null,
    }),
    enabled:
      props.cwd !== null &&
      headerDetail !== null &&
      isSurfaceHydrationReady &&
      tab === "conversation",
  });
  const overview = surfaceQuery.data?.overview ?? null;
  const detail = overview?.detail ?? headerDetail;
  const changesetState = useMemo(
    () => ({
      data: surfaceQuery.data?.changeset,
      isLoading:
        detail !== null &&
        tab === "files" &&
        isSurfaceHydrationReady &&
        surfaceQuery.isLoading &&
        surfaceQuery.data?.changeset === undefined,
      error: surfaceQuery.data?.changeset === undefined ? surfaceQuery.error : null,
    }),
    [
      detail,
      isSurfaceHydrationReady,
      surfaceQuery.data?.changeset,
      surfaceQuery.error,
      surfaceQuery.isLoading,
      tab,
    ],
  );
  const checks = overview?.checks ?? EMPTY_CHECKS;
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
      files: changesetState.data?.files ?? [],
      source: props.source,
      target: changesetState.data?.target ?? null,
      headSha: changesetState.data?.headSha ?? null,
      currentView: tab,
      selectedFilePath,
    });
  }, [
    changesetState.data?.files,
    changesetState.data?.headSha,
    changesetState.data?.target,
    checks,
    detail,
    events,
    props.cwd,
    props.reference,
    props.source,
    selectedFilePath,
    tab,
  ]);
  const prewarmSidechatContext = sidechatContext;
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
    if (!prewarmSidechatContext?.cwd) {
      return null;
    }
    const modelSelection = defaultReviewChatModelSelection();
    return [
      reviewChatPrewarmContextKey(prewarmSidechatContext),
      modelSelection.provider,
      modelSelection.model,
      JSON.stringify(modelSelection.options ?? null),
    ].join("\u001f");
  }, [prewarmSidechatContext]);
  useEffect(() => {
    latestSidechatContextRef.current = prewarmSidechatContext;
  }, [prewarmSidechatContext]);
  useEffect(() => {
    const sidechatContext = latestSidechatContextRef.current;
    if (!sidechatContext?.cwd || !reviewChatPrewarmKey) {
      return;
    }
    const modelSelection = defaultReviewChatModelSelection();
    if (
      prewarmedReviewChatKeyRef.current === reviewChatPrewarmKey ||
      prewarmingReviewChatKeyRef.current === reviewChatPrewarmKey
    ) {
      return;
    }
    prewarmingReviewChatKeyRef.current = reviewChatPrewarmKey;
    void prewarmReviewChatThread({
      payload: sidechatContext,
      modelSelection,
    })
      .then((result) => {
        if (result.status === "ready") {
          prewarmedReviewChatKeyRef.current = reviewChatPrewarmKey;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (prewarmingReviewChatKeyRef.current === reviewChatPrewarmKey) {
          prewarmingReviewChatKeyRef.current = null;
        }
      });
  }, [projects, reviewChatPrewarmKey]);
  const reviewAction =
    tab === "files" ? (
      <ReviewSubmitBar
        mode="header"
        cwd={props.cwd}
        reference={props.reference}
        target={changesetState.data?.target ?? null}
        expectedHeadSha={changesetState.data?.headSha ?? null}
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
                    changesetState={changesetState}
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
                    events={events}
                    isLoading={
                      (detail !== null && tab === "conversation" && !isSurfaceHydrationReady) ||
                      (detail !== null &&
                        tab === "conversation" &&
                        isSurfaceHydrationReady &&
                        conversationQuery.isLoading &&
                        conversationQuery.data === undefined)
                    }
                    className={REVIEW_OVERVIEW_COLUMN_CLASS_NAME}
                  />
                </main>
              )}
            </div>
            {sidechatContext && detail ? (
              <ReviewPrSidebar
                detail={detail}
                checks={checks}
                events={events}
                mode={tab}
                cwd={props.cwd}
                source={props.source}
                target={changesetState.data?.target ?? null}
                sidechatContext={sidechatContext}
                hostThreadId={props.hostThreadId ?? null}
                reviewThreadId={reviewChatThreadId}
                collapsed={sidebarCollapsed}
                onCollapsedChange={updateSidebarCollapsed}
                sidechatOwnsPrewarm={false}
              />
            ) : null}
          </div>
        ) : headerQuery.isLoading ? (
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
        ) : headerQuery.isError ? (
          <div className="min-w-0 flex-1 overflow-y-auto">
            <EmptyState icon={<GitPullRequestIcon />} title="Unavailable">
              {rpcErrorMessage(headerQuery.error) ?? "Could not load this pull request."}
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
