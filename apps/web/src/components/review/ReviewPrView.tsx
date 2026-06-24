import type {
  ReviewChangedFile,
  ReviewCheck,
  ReviewCommit,
  ReviewSourceRef,
  ReviewTimelineEvent,
  ThreadId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  reviewLoadConversationQueryOptions,
  reviewLoadPullRequestHeaderQueryOptions,
  reviewLoadPullRequestQueryOptions,
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
import { ReviewCommits } from "./ReviewCommits";
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
import { ReviewWalkthrough } from "./walkthrough/ReviewWalkthrough";
import { WALKTHROUGH_ENABLED } from "./walkthrough/walkthroughFlag";

type PrTab = "conversation" | "files" | "commits" | "walkthrough";

const EMPTY_CHECKS: ReadonlyArray<ReviewCheck> = [];
const EMPTY_COMMITS: ReadonlyArray<ReviewCommit> = [];
const EMPTY_EVENTS: ReadonlyArray<ReviewTimelineEvent> = [];
const EMPTY_FILES: ReadonlyArray<ReviewChangedFile> = [];

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
  // The walkthrough tab needs the changeset too (for the patch + patchSignature
  // that enable the generate query), so widen the fetch gate beyond Files.
  const needsChangeset = tab === "files" || tab === "walkthrough";
  const surfaceQuery = useQuery({
    ...reviewLoadPullRequestSurfaceQueryOptions({
      cwd: props.cwd,
      reference: headerDetail ? props.reference : null,
      source: props.source,
      includeConversation: false,
      includeChangeset: needsChangeset,
      queryClient,
    }),
    enabled:
      props.cwd !== null && headerDetail !== null && isSurfaceHydrationReady && needsChangeset,
  });
  const overviewQuery = useQuery({
    ...reviewLoadPullRequestQueryOptions({
      cwd: props.cwd,
      reference: headerDetail ? props.reference : null,
    }),
    enabled: props.cwd !== null && headerDetail !== null && isSurfaceHydrationReady,
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
  const overview = surfaceQuery.data?.overview ?? overviewQuery.data ?? null;
  const detail = overview?.detail ?? headerDetail;
  const prBody = detail && detail.body.trim().length > 0 ? detail.body : null;
  const surfaceChangeset = surfaceQuery.data?.changeset;
  const changesetState = useMemo(
    () => ({
      data: surfaceChangeset,
      isLoading:
        detail !== null &&
        needsChangeset &&
        isSurfaceHydrationReady &&
        surfaceQuery.isLoading &&
        surfaceChangeset === undefined,
      error: surfaceChangeset === undefined ? surfaceQuery.error : null,
    }),
    [
      detail,
      isSurfaceHydrationReady,
      needsChangeset,
      surfaceChangeset,
      surfaceQuery.error,
      surfaceQuery.isLoading,
    ],
  );
  const checks = overview?.checks ?? EMPTY_CHECKS;
  const commits = overview?.commits ?? EMPTY_COMMITS;
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
      currentView: tab === "files" ? "files" : "conversation",
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
  }, [reviewChatPrewarmKey]);
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
              ) : tab === "walkthrough" ? (
                <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <ReviewPrHeader
                    detail={detail}
                    variant="compact"
                    contentClassName="px-4 sm:px-5"
                    reviewAction={
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
                    }
                  />
                  <ReviewWalkthrough
                    cwd={props.cwd}
                    reference={props.reference}
                    source={props.source}
                    target={changesetState.data?.target ?? null}
                    patch={changesetState.data?.patch}
                    files={changesetState.data?.files ?? EMPTY_FILES}
                    patchSignature={changesetState.data?.patchSignature ?? null}
                    expectedHeadSha={changesetState.data?.headSha ?? null}
                    title={detail.title}
                    body={prBody}
                  />
                </main>
              ) : (
                <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                  <ReviewPrHeader
                    detail={detail}
                    variant="full"
                    reviewMode="conversation"
                    contentClassName={REVIEW_OVERVIEW_COLUMN_CLASS_NAME}
                    onReviewChanges={() => setTab("files")}
                    onOverview={() => setTab("conversation")}
                    commitsActive={tab === "commits"}
                    onCommits={() => setTab(tab === "commits" ? "conversation" : "commits")}
                    {...(WALKTHROUGH_ENABLED
                      ? {
                          onWalkthrough: () => setTab("walkthrough"),
                          walkthroughActive: false,
                        }
                      : {})}
                  />
                  {tab === "commits" ? (
                    <div className={REVIEW_OVERVIEW_COLUMN_CLASS_NAME}>
                      <ReviewCommits commits={commits} />
                    </div>
                  ) : (
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
                  )}
                </main>
              )}
            </div>
            {sidechatContext && detail ? (
              <ReviewPrSidebar
                detail={detail}
                checks={checks}
                events={events}
                mode={tab === "files" ? "files" : "conversation"}
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
