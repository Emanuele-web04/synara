import type { FileDiffMetadata } from "@pierre/diffs/react";
import type {
  ModelSelection,
  ReviewChangedFile,
  ReviewSourceRef,
  ReviewTargetKey,
  ReviewWalkthroughChapter,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import { reviewGenerateWalkthroughQueryOptions } from "~/lib/reviewReactQuery";
import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { useTheme } from "~/hooks/useTheme";
import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { useReviewViewedFiles } from "../reviewViewedFiles";
import { ReviewCommentThread } from "../ReviewCommentThread";
import type { ReviewLineAnnotationData } from "../reviewAnnotations";
import { useReviewCommentAnnotations } from "../useReviewCommentAnnotations";
import { WalkthroughChapterRail, type WalkthroughReading } from "./WalkthroughChapterRail";
import { WalkthroughChapterReader } from "./WalkthroughChapterReader";
import { WalkthroughControls } from "./WalkthroughControls";
import { WalkthroughPrologue } from "./WalkthroughPrologue";
import { renderWalkthroughStatus } from "./WalkthroughStates";

type ReviewWalkthroughProps = {
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
};

type WalkthroughDiffStyle = "unified" | "split";

function getResponsiveDefaultDiffStyle(): WalkthroughDiffStyle {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches
    ? "split"
    : "unified";
}

export function ReviewWalkthrough(props: ReviewWalkthroughProps): ReactElement {
  return (
    <DiffWorkerPoolProvider>
      <ReviewWalkthroughInner {...props} />
    </DiffWorkerPoolProvider>
  );
}

function ReviewWalkthroughInner(props: ReviewWalkthroughProps): ReactElement | null {
  const { resolvedTheme } = useTheme();
  const { settings, updateSettings } = useAppSettings();
  const readerSectionRef = useRef<HTMLElement>(null);
  const outerScrollRef = useRef<HTMLDivElement>(null);
  const prevReadingRef = useRef<WalkthroughReading | null>(null);
  const [reading, setReading] = useState<WalkthroughReading>("overview");
  const diffStyle = useMemo<WalkthroughDiffStyle>(
    () =>
      settings.reviewWalkthroughDiffStyle === "auto"
        ? getResponsiveDefaultDiffStyle()
        : settings.reviewWalkthroughDiffStyle,
    [settings.reviewWalkthroughDiffStyle],
  );
  const [completedChapterIds, setCompletedChapterIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsedFilePaths, setCollapsedFilePaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const providerOptions = useMemo(() => getProviderStartOptions(settings), [settings]);
  const modelSelection = useMemo<ModelSelection | undefined>(
    () =>
      settings.textGenerationModel && settings.textGenerationProvider
        ? {
            provider: settings.textGenerationProvider,
            model: settings.textGenerationModel,
          }
        : undefined,
    [settings.textGenerationModel, settings.textGenerationProvider],
  );

  const walkthroughQuery = useQuery(
    reviewGenerateWalkthroughQueryOptions({
      cwd: props.cwd,
      reference: props.reference,
      source: props.source,
      patchSignature: props.patchSignature,
      ...(props.expectedHeadSha !== null ? { expectedHeadSha: props.expectedHeadSha } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(settings.textGenerationModel
        ? { textGenerationModel: settings.textGenerationModel }
        : {}),
      ...(settings.codexHomePath ? { codexHomePath: settings.codexHomePath } : {}),
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
  const commentTools = useReviewCommentAnnotations({
    target: props.target,
    cwd: props.cwd,
    reference: props.reference,
    patchSignature: props.patchSignature,
    headSha: props.expectedHeadSha,
  });

  const renderAnnotation = useCallback(
    (data: ReviewLineAnnotationData) => (
      <ReviewCommentThread
        data={data}
        actions={commentTools.threadActions}
        viewer={commentTools.viewer}
      />
    ),
    [commentTools.threadActions, commentTools.viewer],
  );

  useEffect(() => {
    setCollapsedFilePaths(new Set());
  }, [props.reference, props.patchSignature, props.expectedHeadSha]);

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

  const onReadingViewMount = useCallback(
    (node: HTMLDivElement | null): void => {
      if (!node) {
        return;
      }
      const readingChanged = reading !== prevReadingRef.current;
      prevReadingRef.current = reading;
      if (!readingChanged) {
        return;
      }
      readerSectionRef.current?.scrollTo({ top: 0, behavior: "auto" });
      outerScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
      const fromNav = document.activeElement?.closest(
        "[data-walkthrough-rail],[data-walkthrough-controls]",
      );
      if (fromNav) {
        return;
      }
      const heading = node.querySelector<HTMLElement>("[data-walkthrough-heading]");
      (heading ?? node).focus({ preventScroll: true });
    },
    [reading],
  );

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
  const toggleDiffStyle = (): void => {
    updateSettings({
      reviewWalkthroughDiffStyle: diffStyle === "split" ? "unified" : "split",
    });
  };
  const toggleCollapsedFile = (path: string): void => {
    setCollapsedFilePaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div data-walkthrough-controls>
        <WalkthroughControls diffStyle={diffStyle} onToggleDiffStyle={toggleDiffStyle} />
      </div>
      <div
        ref={outerScrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)] xl:overflow-hidden"
      >
        <section
          ref={readerSectionRef}
          aria-label="Walkthrough reader"
          className="order-2 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto bg-background xl:order-1"
        >
          <div
            key={activeChapter?.id ?? "overview"}
            ref={onReadingViewMount}
            tabIndex={-1}
            className="outline-none animate-in fade-in duration-200 ease-out fill-mode-both motion-reduce:animate-none"
          >
            {activeChapter && activeIndex >= 0 ? (
              <WalkthroughChapterReader
                chapter={activeChapter}
                index={activeIndex}
                total={chapters.length}
                fileDiffs={chapterFileDiffs(activeChapter, fileDiffsByPath)}
                theme={resolvedTheme}
                diffStyle={diffStyle}
                commentsEnabled={commentTools.commentsEnabled}
                annotationsByFile={commentTools.annotationsByFile}
                completed={completedChapterIds.has(activeChapter.id)}
                viewedPaths={viewedPaths}
                collapsedFilePaths={collapsedFilePaths}
                onToggleViewed={toggleViewed}
                onToggleCollapsed={toggleCollapsedFile}
                onStartDraft={commentTools.startDraft}
                renderAnnotation={renderAnnotation}
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
                cwd={props.cwd}
                canStart={chapters.length > 0}
                onStart={() => setReading(chapters[0]!.id)}
              />
            )}
          </div>
        </section>
        <aside
          aria-label="Walkthrough chapters"
          data-walkthrough-rail
          className="order-1 max-h-[38vh] overflow-y-auto overscroll-contain border-b border-border/40 bg-background sm:max-h-[42vh] xl:order-2 xl:max-h-none xl:overflow-visible xl:border-b-0 xl:border-l"
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
