import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { ChevronRightIcon, GitPullRequestIcon, PlusIcon, XIcon } from "~/lib/icons";
import { reviewListPullRequestsQueryOptions } from "~/lib/reviewReactQuery";
import { cn } from "~/lib/utils";

const REVIEW_OPEN_TABS_STORAGE_PREFIX = "review:open-pr-tabs";
const MAX_OPEN_REVIEW_TABS = 12;

export interface OpenReviewTab {
  reference: string;
  title: string | null;
}

export interface CloseOpenReviewTabResult {
  tabs: OpenReviewTab[];
  nextReference: string | null;
}

function normalizeReference(reference: string): string {
  const trimmed = reference.trim();
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

function tabsStorageKey(cwd: string | null): string {
  return `${REVIEW_OPEN_TABS_STORAGE_PREFIX}:${cwd ?? "default"}`;
}

function readStoredTabs(cwd: string | null): OpenReviewTab[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(tabsStorageKey(cwd));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry): OpenReviewTab[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.reference !== "string" || record.reference.trim().length === 0) {
        return [];
      }
      return [
        {
          reference: normalizeReference(record.reference),
          title: typeof record.title === "string" && record.title.trim() ? record.title : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

function writeStoredTabs(cwd: string | null, tabs: ReadonlyArray<OpenReviewTab>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(tabsStorageKey(cwd), JSON.stringify(tabs));
  } catch {
    // Local tab memory is a convenience. Storage failures should not block review navigation.
  }
}

export function upsertCurrentTab(
  tabs: ReadonlyArray<OpenReviewTab>,
  reference: string,
  title: string | null,
): OpenReviewTab[] {
  const normalizedReference = normalizeReference(reference);
  const existingIndex = tabs.findIndex(
    (tab) => normalizeReference(tab.reference) === normalizedReference,
  );
  if (existingIndex >= 0) {
    return tabs.map((tab, index) =>
      index === existingIndex
        ? {
            reference: normalizedReference,
            title: title ?? tab.title,
          }
        : tab,
    );
  }
  return [...tabs, { reference: normalizedReference, title }].slice(-MAX_OPEN_REVIEW_TABS);
}

export function closeOpenReviewTab(
  tabs: ReadonlyArray<OpenReviewTab>,
  reference: string,
  activeReference: string | null,
): CloseOpenReviewTabResult {
  const normalizedClosedReference = normalizeReference(reference);
  const normalizedActiveReference = activeReference ? normalizeReference(activeReference) : null;
  const closedIndex = tabs.findIndex(
    (tab) => normalizeReference(tab.reference) === normalizedClosedReference,
  );
  if (closedIndex < 0) {
    return { tabs: [...tabs], nextReference: null };
  }
  const nextTabs = tabs.filter(
    (tab) => normalizeReference(tab.reference) !== normalizedClosedReference,
  );
  if (normalizedClosedReference !== normalizedActiveReference) {
    return { tabs: nextTabs, nextReference: null };
  }
  const fallback = nextTabs[Math.max(0, closedIndex - 1)] ?? nextTabs[0] ?? null;
  return {
    tabs: nextTabs,
    nextReference: fallback ? normalizeReference(fallback.reference) : null,
  };
}

function titleForReference(
  reference: string,
  summariesByReference: ReadonlyMap<string, ReviewPullRequestSummary>,
  fallback: string | null,
): string {
  return (
    summariesByReference.get(normalizeReference(reference))?.title ?? fallback ?? `#${reference}`
  );
}

export function ReviewBrowserTabs(props: {
  cwd: string | null;
  reference?: string | null;
  currentTitle: string | null;
}) {
  const navigate = useNavigate();
  const normalizedReference = props.reference ? normalizeReference(props.reference) : null;
  const tabButtonByReference = useRef<Record<string, HTMLButtonElement | null>>({});
  const [openTabs, setOpenTabs] = useState<OpenReviewTab[]>(() =>
    normalizedReference
      ? upsertCurrentTab(readStoredTabs(props.cwd), normalizedReference, props.currentTitle)
      : readStoredTabs(props.cwd),
  );
  const pullRequestsQuery = useQuery(
    reviewListPullRequestsQueryOptions({ cwd: props.cwd, limit: 25 }),
  );

  useEffect(() => {
    setOpenTabs(
      normalizedReference
        ? upsertCurrentTab(readStoredTabs(props.cwd), normalizedReference, props.currentTitle)
        : readStoredTabs(props.cwd),
    );
  }, [props.cwd, normalizedReference, props.currentTitle]);

  useEffect(() => {
    writeStoredTabs(props.cwd, openTabs);
  }, [props.cwd, openTabs]);

  const summariesByReference = useMemo(() => {
    const entries = (pullRequestsQuery.data?.pullRequests ?? []).map(
      (pullRequest) => [String(pullRequest.number), pullRequest] as const,
    );
    return new Map(entries);
  }, [pullRequestsQuery.data]);

  const navigateToReference = (reference: string) => {
    void navigate({
      to: "/review/$reference",
      params: { reference: normalizeReference(reference) },
      ...(props.cwd ? { search: { cwd: props.cwd } } : {}),
    });
  };

  const closeTab = (reference: string) => {
    const result = closeOpenReviewTab(openTabs, reference, normalizedReference);
    setOpenTabs(result.tabs);

    if (!result.nextReference) {
      if (result.tabs.length === 0 && normalizeReference(reference) === normalizedReference) {
        void navigate({
          to: "/review",
          replace: true,
          search: props.cwd ? { cwd: props.cwd } : {},
        });
      }
      return;
    }
    navigateToReference(result.nextReference);
  };

  const focusAndOpenTab = (reference: string) => {
    const normalizedTarget = normalizeReference(reference);
    tabButtonByReference.current[normalizedTarget]?.focus();
    navigateToReference(normalizedTarget);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, reference: string) => {
    const currentIndex = openTabs.findIndex(
      (tab) => normalizeReference(tab.reference) === normalizeReference(reference),
    );
    if (currentIndex < 0) {
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      const nextIndex = (currentIndex + delta + openTabs.length) % openTabs.length;
      const nextTab = openTabs[nextIndex];
      if (nextTab) {
        focusAndOpenTab(nextTab.reference);
      }
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      const firstTab = openTabs[0];
      if (firstTab) {
        focusAndOpenTab(firstTab.reference);
      }
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      const lastTab = openTabs.at(-1);
      if (lastTab) {
        focusAndOpenTab(lastTab.reference);
      }
      return;
    }

    if (
      event.key === "Delete" ||
      event.key === "Backspace" ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w")
    ) {
      event.preventDefault();
      closeTab(reference);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
      <button
        type="button"
        className="hidden h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring xl:inline-flex"
        aria-label="Review, Pull requests"
        onClick={() => {
          void navigate({
            to: "/review",
            search: props.cwd ? { cwd: props.cwd } : {},
          });
        }}
      >
        <span>Review</span>
        <ChevronRightIcon className="size-3 text-muted-foreground/60" aria-hidden="true" />
        <span className="text-foreground/88">Pull requests</span>
      </button>

      <div
        role="tablist"
        aria-label="Open pull requests"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {openTabs.map((tab) => {
          const tabReference = normalizeReference(tab.reference);
          const active = tabReference === normalizedReference;
          const title = titleForReference(tabReference, summariesByReference, tab.title);
          return (
            <div
              key={tabReference}
              className={cn(
                "group/tab relative flex h-8 min-w-[9.5rem] max-w-[17rem] shrink-0 items-center gap-1 rounded-xl border px-2",
                "transition-[background-color,border-color,box-shadow,color] duration-150 motion-reduce:transition-none",
                active
                  ? "border-border/55 bg-muted/45 text-foreground"
                  : "border-transparent bg-transparent text-muted-foreground hover:bg-muted/35 hover:text-foreground",
              )}
            >
              <button
                type="button"
                ref={(element) => {
                  if (element) {
                    tabButtonByReference.current[tabReference] = element;
                  } else {
                    delete tabButtonByReference.current[tabReference];
                  }
                }}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => navigateToReference(tabReference)}
                onKeyDown={(event) => handleTabKeyDown(event, tabReference)}
              >
                <GitPullRequestIcon className="size-3 shrink-0" />
                <span className="min-w-0 truncate font-medium text-[12px]" title={title}>
                  {title}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums opacity-55">
                  #{tabReference}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Close ${title}`}
                title="Close tab"
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none",
                  "transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "opacity-70 hover:opacity-100"
                    : "opacity-35 group-hover/tab:opacity-100",
                )}
                onClick={() => closeTab(tabReference)}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/45 bg-muted/20 text-muted-foreground outline-none transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-muted/20 disabled:hover:text-muted-foreground"
        aria-label="Open another pull request"
        title="Open another pull request"
        disabled={!props.cwd}
        onClick={() => {
          void navigate({
            to: "/review",
            search: props.cwd ? { cwd: props.cwd } : {},
          });
        }}
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}
