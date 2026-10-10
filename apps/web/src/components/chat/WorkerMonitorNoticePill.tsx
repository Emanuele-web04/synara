import { ProjectId, ThreadId } from "@synara/contracts";
import { useState } from "react";
import type { WorkLogEntry, WorkLogSynaraWorkerNotice } from "../../workLog";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { Button } from "../ui/button";

const OUTCOME_LABELS: Record<string, string> = {
  completed: "done",
  stopped: "stopped",
  failed: "failed",
  interrupted: "interrupted",
  missing: "missing",
  "waiting-approval": "needs your approval",
  "waiting-input": "needs your input",
};

interface WorkerMonitorNoticePillProps {
  entry: WorkLogEntry;
  notice: WorkLogSynaraWorkerNotice;
  onOpenThread?: (threadId: ThreadId) => void;
}

/**
 * Compact coordinator monitor row: worker settled / stuck / "Waiting on you" /
 * batch roll-up pills in the coordinator conversation. The needs-you variant
 * renders Synara-native actions (retry, stop, open thread) wired to real
 * Synara commands — never a fake provider input card.
 */
export function WorkerMonitorNoticePill({
  entry,
  notice,
  onOpenThread,
}: WorkerMonitorNoticePillProps) {
  const [pendingAction, setPendingAction] = useState<"retry" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsYouThread = notice.kind === "needs-you" ? notice.threads[0] : undefined;
  const projectId = needsYouThread?.projectId ?? null;

  const resolveWorker = (action: "retry" | "stop") => {
    const api = readNativeApi();
    if (!api || !needsYouThread || !projectId || pendingAction !== null) return;
    setPendingAction(action);
    setError(null);
    void api.projectAgent
      .resolveWorker({
        requestId: `worker-resolve:${entry.id}:${action}`,
        projectId: ProjectId.makeUnsafe(projectId),
        threadId: ThreadId.makeUnsafe(needsYouThread.threadId),
        action,
      })
      .then(() => setPendingAction(null))
      .catch((err: unknown) => {
        setPendingAction(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div
      className={cn(
        // Reads as part of the coordinator's reply: left-aligned body text,
        // no pill, no status glyphs.
        "flex max-w-full flex-wrap items-center gap-x-1 gap-y-1 text-chat text-foreground",
      )}
      data-worker-monitor-kind={notice.kind}
    >
      {notice.kind === "rollup" ? (
        <div className="flex w-full flex-col gap-1">
          <span>
            {entry.label.includes(":")
              ? entry.label.slice(0, entry.label.indexOf(":") + 1)
              : entry.label}
          </span>
          <ul className="flex list-disc flex-col gap-0.5 pl-5">
            {notice.threads.map((thread) => (
              <li key={`worker-monitor-thread:${thread.threadId}`}>
                <button
                  type="button"
                  className="inline p-0 text-inherit underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground/70"
                  onClick={() => onOpenThread?.(ThreadId.makeUnsafe(thread.threadId))}
                >
                  {thread.title}
                </button>
                {thread.outcome ? (
                  <span className={MUTED_LABEL_TEXT_CLASS_NAME}>
                    {` (${OUTCOME_LABELS[thread.outcome] ?? thread.outcome})`}
                  </span>
                ) : null}
                {thread.pr ? (
                  <>
                    {" · "}
                    <a
                      href={thread.pr}
                      target="_blank"
                      rel="noreferrer"
                      className="inline p-0 text-inherit underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground/70"
                    >
                      PR
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          {notice.threads.map((thread) => (
            <span
              key={`worker-monitor-thread:${thread.threadId}`}
              className="inline-flex items-center gap-1"
            >
              <button
                type="button"
                className="inline p-0 text-inherit underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground/70"
                onClick={() => onOpenThread?.(ThreadId.makeUnsafe(thread.threadId))}
              >
                {thread.title}
              </button>
              {thread.pr ? (
                <a
                  href={thread.pr}
                  target="_blank"
                  rel="noreferrer"
                  className="inline p-0 text-inherit underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground/70"
                >
                  PR
                </a>
              ) : null}
            </span>
          ))}
          {notice.phrase ? <span>{`${notice.phrase}.`}</span> : null}
        </>
      )}
      {needsYouThread && projectId ? (
        <span className="inline-flex items-center gap-1">
          {(notice.actions ?? []).includes("retry") ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pendingAction !== null}
              onClick={() => resolveWorker("retry")}
            >
              Retry
            </Button>
          ) : null}
          {(notice.actions ?? []).includes("stop") ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pendingAction !== null}
              onClick={() => resolveWorker("stop")}
            >
              Stop worker
            </Button>
          ) : null}
          {(notice.actions ?? []).includes("open") ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onOpenThread?.(ThreadId.makeUnsafe(needsYouThread.threadId))}
            >
              Open thread
            </Button>
          ) : null}
        </span>
      ) : null}
      {error ? <span className="text-destructive">{error}</span> : null}
    </div>
  );
}
