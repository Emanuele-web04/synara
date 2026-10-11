import { ThreadId, type LoadProjectImportHistoryResult } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { expensiveReadErrorRefetchInterval } from "~/lib/expensiveReadRetry";
import { ensureNativeApi } from "~/nativeApi";

type HistoryState = LoadProjectImportHistoryResult & {
  threadId: string;
  loading: boolean;
  error: unknown;
  failureCount: number;
};
const EMPTY_MESSAGES: LoadProjectImportHistoryResult["messages"] = [];

export function useImportedHistory(threadId: string, enabled: boolean) {
  const [state, setState] = useState<HistoryState | null>(null);
  const generation = useRef(0);
  const requestPending = useRef(false);
  const loadPage = useCallback(
    async (cursor: string | null = null) => {
      if (requestPending.current || !enabled) return;
      requestPending.current = true;
      const requestGeneration = generation.current;
      setState((previous) => ({
        threadId,
        messages: previous?.threadId === threadId ? previous.messages : EMPTY_MESSAGES,
        nextCursor: cursor,
        loading: true,
        error: null,
        failureCount: previous?.threadId === threadId ? previous.failureCount : 0,
      }));
      try {
        const result = await ensureNativeApi().orchestration.loadProjectImportHistory({
          threadId: ThreadId.makeUnsafe(threadId),
          ...(cursor ? { cursor } : {}),
        });
        if (generation.current !== requestGeneration) return;
        setState((previous) => {
          const existing = previous?.threadId === threadId ? previous.messages : EMPTY_MESSAGES;
          const ids = new Set(existing.map((message) => message.messageId));
          return {
            threadId,
            nextCursor: result.nextCursor,
            messages: [
              ...result.messages.filter((message) => !ids.has(message.messageId)),
              ...existing,
            ],
            loading: false,
            error: null,
            failureCount: 0,
          };
        });
      } catch (error) {
        if (generation.current !== requestGeneration) return;
        setState((previous) => ({
          threadId,
          nextCursor: cursor,
          messages: previous?.threadId === threadId ? previous.messages : EMPTY_MESSAGES,
          loading: false,
          error,
          failureCount: (previous?.threadId === threadId ? previous.failureCount : 0) + 1,
        }));
      } finally {
        if (generation.current === requestGeneration) requestPending.current = false;
      }
    },
    [threadId, enabled],
  );

  useEffect(() => {
    generation.current += 1;
    requestPending.current = false;
    setState(null);
    void loadPage();
    return () => {
      generation.current += 1;
    };
  }, [loadPage]);

  const current = enabled && state?.threadId === threadId ? state : null;
  const load = useCallback(() => loadPage(current?.nextCursor), [loadPage, current?.nextCursor]);
  const retryDelay = expensiveReadErrorRefetchInterval({
    state: { error: current?.error, errorUpdateCount: current?.failureCount ?? 0 },
  });
  useEffect(() => {
    if (retryDelay === false) return;
    const timer = setTimeout(() => {
      void load();
    }, retryDelay);
    return () => clearTimeout(timer);
  }, [load, retryDelay, current?.failureCount]);

  return {
    messages: current?.messages ?? EMPTY_MESSAGES,
    nextCursor: current?.nextCursor ?? null,
    loading: (current?.loading ?? false) || retryDelay !== false,
    error:
      retryDelay !== false || !current?.error
        ? null
        : current.error instanceof Error
          ? current.error.message
          : "Could not load history.",
    load,
  };
}

export function ImportedHistoryButton({
  history,
  onFirstMessage,
  completeLabel,
  loadLabel = "Load earlier messages",
}: {
  history: { nextCursor: unknown; loading: boolean; error: string | null; load: () => unknown };
  onFirstMessage?: () => void;
  completeLabel?: string;
  loadLabel?: string;
}) {
  const complete = !history.nextCursor && !history.error && !history.loading;
  if (complete && !completeLabel) return null;
  return (
    <div
      className="flex flex-col items-center gap-1 px-3 pb-4 text-ui-sm text-muted-foreground"
      data-scroll-anchor-ignore
    >
      <Button
        size="sm"
        variant="ghost"
        disabled={history.loading || complete}
        onClick={() => {
          void history.load();
        }}
      >
        {complete
          ? completeLabel
          : history.loading
            ? "Loading earlier messages…"
            : history.error
              ? "Retry loading earlier messages"
              : loadLabel}
      </Button>
      {onFirstMessage && (history.nextCursor || completeLabel) ? (
        <Button size="sm" variant="ghost" disabled={history.loading} onClick={onFirstMessage}>
          Go to first message
        </Button>
      ) : null}
      {history.error ? (
        <p role="alert" className="max-w-prose text-center text-ui-xs text-destructive">
          {history.error}
        </p>
      ) : null}
    </div>
  );
}
