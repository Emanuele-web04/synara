import { ThreadId, type LoadProjectImportHistoryResult } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ensureNativeApi } from "~/nativeApi";

type HistoryState = LoadProjectImportHistoryResult & {
  threadId: string;
  loading: boolean;
  error: string | null;
};
const EMPTY_MESSAGES: LoadProjectImportHistoryResult["messages"] = [];

export function useImportedHistory(threadId: string, enabled: boolean) {
  const [state, setState] = useState<HistoryState | null>(null);
  const generation = useRef(0);
  const requestPending = useRef(false);
  useEffect(() => {
    const requestGeneration = ++generation.current;
    requestPending.current = false;
    setState(null);
    if (!enabled) return;
    void Promise.resolve()
      .then(
        () =>
          ensureNativeApi().orchestration.loadProjectImportHistory?.({
            threadId: ThreadId.makeUnsafe(threadId),
          }) ?? { messages: [], nextCursor: null },
      )
      .then((result) => {
        if (generation.current === requestGeneration)
          setState({ ...result, threadId, loading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (generation.current === requestGeneration)
          setState({
            threadId,
            messages: [],
            nextCursor: null,
            loading: false,
            error: cause instanceof Error ? cause.message : "Could not load history.",
          });
      });
    return () => {
      generation.current += 1;
    };
  }, [threadId, enabled]);

  const current = state?.threadId === threadId ? state : null;
  const load = useCallback(async () => {
    if (requestPending.current || !enabled) return;
    requestPending.current = true;
    const requestGeneration = generation.current;
    setState((previous) =>
      previous?.threadId === threadId ? { ...previous, loading: true, error: null } : previous,
    );
    try {
      const result = await ensureNativeApi().orchestration.loadProjectImportHistory({
        threadId: ThreadId.makeUnsafe(threadId),
        ...(current?.nextCursor ? { cursor: current.nextCursor } : {}),
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
        };
      });
    } catch (cause) {
      if (generation.current !== requestGeneration) return;
      setState((previous) => ({
        threadId,
        nextCursor: current?.nextCursor ?? null,
        messages: previous?.threadId === threadId ? previous.messages : [],
        loading: false,
        error: cause instanceof Error ? cause.message : "Could not load history.",
      }));
    } finally {
      if (generation.current === requestGeneration) requestPending.current = false;
    }
  }, [threadId, enabled, current?.nextCursor]);
  return {
    messages: current?.messages ?? EMPTY_MESSAGES,
    nextCursor: current?.nextCursor ?? null,
    loading: current?.loading ?? false,
    error: current?.error ?? null,
    load,
  };
}

export function ImportedHistoryButton({
  history,
}: {
  history: ReturnType<typeof useImportedHistory>;
}) {
  if (!history.nextCursor && !history.error) return null;
  return (
    <div
      className="flex flex-col items-center gap-1 px-3 pb-4 text-ui-sm text-muted-foreground"
      data-scroll-anchor-ignore
    >
      <Button
        size="sm"
        variant="ghost"
        disabled={history.loading}
        onClick={() => {
          void history.load();
        }}
      >
        {history.loading
          ? "Loading earlier messages…"
          : history.error
            ? "Retry loading earlier messages"
            : "Load earlier messages"}
      </Button>
      {history.error ? (
        <p role="alert" className="max-w-prose text-center text-ui-xs text-destructive">
          {history.error}
        </p>
      ) : null}
    </div>
  );
}
