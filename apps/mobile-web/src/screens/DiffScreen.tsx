import { IconCode, IconFileDiff, IconMinus, IconPlus } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCompanion } from "../companionContext";
import { EmptyState, InlineError, LoadingBlock, ScreenHeader } from "../components/ui";
import type { DiffFile } from "../domain";

export function DiffScreen() {
  const { threadId } = useParams({ strict: false }) as { readonly threadId: string };
  const { diffs, threads, loadDiff } = useCompanion();
  const diff = diffs.get(threadId);
  const thread = threads.get(threadId);
  const [loading, setLoading] = useState(!diff);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void loadDiff(threadId)
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "The diff could not be loaded.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadDiff, threadId]);

  const totals = useMemo(
    () =>
      diff?.files.reduce(
        (result, file) => ({
          additions: result.additions + file.additions,
          deletions: result.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ) ?? { additions: 0, deletions: 0 },
    [diff],
  );

  return (
    <div className="screen diff-screen">
      <ScreenHeader title="Changes" eyebrow={thread?.title ?? "Task diff"} back />
      {loading && !diff ? <LoadingBlock label="Loading changes" /> : null}
      {error ? <InlineError>{error}</InlineError> : null}
      {diff ? (
        <>
          <div className="diff-summary">
            <span>{diff.files.length} changed files</span>
            <span className="diff-additions">
              <IconPlus aria-hidden="true" size={15} /> {totals.additions}
            </span>
            <span className="diff-deletions">
              <IconMinus aria-hidden="true" size={15} /> {totals.deletions}
            </span>
          </div>
          {diff.files.length > 0 ? (
            <VirtualDiffFiles files={diff.files} />
          ) : (
            <EmptyState
              icon={<IconFileDiff size={24} />}
              title="No file changes"
              description="This task has not changed tracked files."
            />
          )}
          <p className="readonly-note">
            <IconCode aria-hidden="true" size={17} />
            Changes are read-only on mobile. Use the desktop app for Git actions.
          </p>
        </>
      ) : null}
    </div>
  );
}

function VirtualDiffFiles({ files }: { readonly files: readonly DiffFile[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 520,
    getItemKey: (index) => files[index]?.path ?? index,
    overscan: 2,
  });
  return (
    <div className="diff-files virtual-diff-files" ref={scrollRef}>
      <div className="virtual-diff-files__inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualFile) => {
          const file = files[virtualFile.index];
          if (!file) return null;
          return (
            <div
              className="virtual-diff-files__row"
              data-index={virtualFile.index}
              key={virtualFile.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualFile.start}px)` }}
            >
              <DiffFileView file={file} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffFileView({ file }: { readonly file: DiffFile }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: file.lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 16,
    getItemKey: (index) => `${index}:${file.lines[index]?.text ?? ""}`,
    overscan: 24,
  });
  return (
    <article className="diff-file">
      <header>
        <IconFileDiff aria-hidden="true" size={17} />
        <strong>{file.path}</strong>
        <span className="diff-additions">+{file.additions}</span>
        <span className="diff-deletions">−{file.deletions}</span>
      </header>
      <div
        className="diff-code"
        ref={scrollRef}
        role="region"
        aria-label={`Diff for ${file.path}`}
        tabIndex={0}
      >
        <div className="virtual-diff" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualLine) => {
            const line = file.lines[virtualLine.index];
            if (!line) return null;
            return (
              <div
                className="diff-line virtual-diff__line"
                data-index={virtualLine.index}
                data-kind={line.kind}
                key={virtualLine.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${virtualLine.start}px)` }}
              >
                <span aria-hidden="true">{line.oldLine ?? ""}</span>
                <span aria-hidden="true">{line.newLine ?? ""}</span>
                <code>{line.text || " "}</code>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}
