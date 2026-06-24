import type { FileDiffMetadata } from "@pierre/diffs/react";
import type {
  ReviewChangedFile,
  ReviewSourceRef,
  ReviewTargetKey,
  ReviewWalkthroughChapter,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import { reviewGenerateWalkthroughQueryOptions } from "~/lib/reviewReactQuery";
import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { useTheme } from "~/hooks/useTheme";
import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { useReviewViewedFiles } from "../reviewViewedFiles";
import { WalkthroughChapterRail, type WalkthroughReading } from "./WalkthroughChapterRail";
import { WalkthroughChapterReader } from "./WalkthroughChapterReader";
import { WalkthroughControls } from "./WalkthroughControls";
import { WalkthroughPrologue } from "./WalkthroughPrologue";
import { renderWalkthroughStatus } from "./WalkthroughStates";

export function ReviewWalkthrough(props: {
  cwd: string | null;
  reference: string;
  source: ReviewSourceRef;
  target: ReviewTargetKey | null;
  patch: string | undefined;
  files: readonly ReviewChangedFile[];
  patchSignature: string | null;
  expectedHeadSha: string | null;
  changesetError: unknown;
  changesetLoading: boolean;
  title: string;
  body: string | null;
}): ReactElement {
  return (
    <DiffWorkerPoolProvider>
      <ReviewWalkthroughInner {...props} />
    </DiffWorkerPoolProvider>
  );
}

function ReviewWalkthroughInner(props: {
  cwd: string | null;
  reference: string;
  source: ReviewSourceRef;
  target: ReviewTargetKey | null;
  patch: string | undefined;
  files: readonly ReviewChangedFile[];
  patchSignature: string | null;
  expectedHeadSha: string | null;
  changesetError: unknown;
  changesetLoading: boolean;
  title: string;
  body: string | null;
}): ReactElement | null {
  const { resolvedTheme } = useTheme();
  const [reading, setReading] = useState<WalkthroughReading>("overview");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches
      ? "split"
      : "unified",
  );
  const [completedChapterIds, setCompletedChapterIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const walkthroughQuery = useQuery(
    reviewGenerateWalkthroughQueryOptions({
      cwd: props.cwd,
      reference: props.reference,
      source: props.source,
      patchSignature: props.patchSignature,
      ...(props.expectedHeadSha !== null ? { expectedHeadSha: props.expectedHeadSha } : {}),
    }),
  );

  const filesByPath = useMemo(() => {
    const map = new Map<string, ReviewChangedFile>();
    for (const file of props.files) {
      map.set(file.path, file);
    }
    return map;
  }, [props.files]);

  const fileDiffsByPath = useMemo(() => {
    const renderable = getRenderablePatch(props.patch, "review:walkthrough");
    const map = new Map<string, FileDiffMetadata>();
    if (renderable?.kind === "files") {
      for (const fileDiff of renderable.files) {
        map.set(resolveFileDiffPath(fileDiff), fileDiff);
      }
    }
    return map;
  }, [props.patch]);

  const result = walkthroughQuery.data ?? null;
  const walkthrough = result?.walkthrough ?? null;
  const chapters = walkthrough?.chapters ?? [];

  const allFilePaths = useMemo(() => props.files.map((file) => file.path), [props.files]);
  const { viewedPaths, toggleViewed } = useReviewViewedFiles(props.target, allFilePaths);

  const activeChapter =
    reading === "overview" ? null : (chapters.find((chapter) => chapter.id === reading) ?? null);

  const toggleComplete = (chapterId: string): void => {
    setCompletedChapterIds((previous) => {
      const next = new Set(previous);
      if (next.has(chapterId)) {
        next.delete(chapterId);
      } else {
        next.add(chapterId);
      }
      return next;
    });
  };

  const status = renderWalkthroughStatus({
    changesetError: props.changesetError,
    changesetLoading: props.changesetLoading,
    queryLoading: walkthroughQuery.isLoading,
    queryError: walkthroughQuery.error,
    isError: walkthroughQuery.isError,
    headMoved: Boolean(result?.headMoved || result?.patchChanged),
    movedWarning: result?.warnings?.[0] ?? null,
    isEmpty: !walkthrough || chapters.length === 0,
    isFetching: walkthroughQuery.isFetching,
    onRetry: () => void walkthroughQuery.refetch(),
  });
  if (status) {
    return status;
  }
  if (!walkthrough) {
    return null;
  }

  const activeIndex = activeChapter
    ? chapters.findIndex((chapter) => chapter.id === activeChapter.id)
    : -1;
  const nextChapter =
    activeIndex >= 0 && activeIndex < chapters.length - 1 ? chapters[activeIndex + 1]! : null;

  const openChapter = (chapter: ReviewWalkthroughChapter): void => {
    setReading(chapter.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
      <WalkthroughControls
        diffStyle={diffStyle}
        onToggleDiffStyle={() => setDiffStyle((value) => (value === "split" ? "unified" : "split"))}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)] xl:overflow-hidden">
        <section
          aria-label="Walkthrough reader"
          className="order-2 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto bg-background xl:order-1"
        >
          {activeChapter && activeIndex >= 0 ? (
            <WalkthroughChapterReader
              chapter={activeChapter}
              index={activeIndex}
              total={chapters.length}
              fileDiffs={chapterFileDiffs(activeChapter, fileDiffsByPath)}
              theme={resolvedTheme}
              diffStyle={diffStyle}
              completed={completedChapterIds.has(activeChapter.id)}
              viewedPaths={viewedPaths}
              onToggleViewed={toggleViewed}
              onToggleComplete={() => toggleComplete(activeChapter.id)}
              onNavigatePrevious={() =>
                setReading(activeIndex <= 0 ? "overview" : chapters[activeIndex - 1]!.id)
              }
              onNavigateNext={nextChapter ? () => setReading(nextChapter.id) : null}
            />
          ) : (
            <WalkthroughPrologue
              prologue={walkthrough.prologue}
              title={props.title}
              body={props.body}
              canStart={chapters.length > 0}
              onStart={() => setReading(chapters[0]!.id)}
            />
          )}
        </section>
        <aside
          aria-label="Walkthrough navigation"
          className="order-1 max-h-[38vh] overflow-y-auto overscroll-contain border-b border-border/40 bg-[var(--color-background-surface)] sm:max-h-[42vh] xl:order-2 xl:max-h-none xl:overflow-visible xl:border-b-0 xl:border-l"
        >
          <WalkthroughChapterRail
            chapters={chapters}
            reading={reading}
            filesByPath={filesByPath}
            viewedPaths={viewedPaths}
            onOpenOverview={() => setReading("overview")}
            onOpenChapter={openChapter}
          />
        </aside>
      </div>
    </div>
  );
}

function chapterFileDiffs(
  chapter: ReviewWalkthroughChapter,
  fileDiffsByPath: ReadonlyMap<string, FileDiffMetadata>,
): FileDiffMetadata[] {
  const diffs: FileDiffMetadata[] = [];
  for (const path of chapter.files) {
    const fileDiff = fileDiffsByPath.get(path);
    if (fileDiff) {
      diffs.push(fileDiff);
    }
  }
  return diffs;
}
