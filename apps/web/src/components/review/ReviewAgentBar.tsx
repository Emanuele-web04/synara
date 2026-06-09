import type { ModelSelection, ReviewSourceRef, ReviewTargetKey } from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { getProviderStartOptions } from "~/appSettings";
import { BotIcon, Loader2Icon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { reviewRunAgentMutationOptions } from "~/lib/reviewReactQuery";
import { cn } from "~/lib/utils";
import { reviewTargetKeyString } from "~/reviewStore.logic";
import { selectReviewAgentFindings, useReviewStore } from "~/reviewStore";
import { Button } from "../ui/button";

type RunStatus =
  | { kind: "idle" }
  | {
      kind: "success";
      runKey: string;
      summary: string;
      count: number;
      warnings: ReadonlyArray<string>;
    }
  | { kind: "error"; runKey: string; message: string };

export function ReviewAgentBar(props: {
  mode: "page" | "dock" | "rail" | "inline";
  cwd: string | null;
  source: ReviewSourceRef | null;
  target: ReviewTargetKey | null;
  expectedHeadSha?: string | null;
  patchSignature?: string | null;
}) {
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const setAgentFindings = useReviewStore((store) => store.setAgentFindings);
  const clearAgentFindings = useReviewStore((store) => store.clearAgentFindings);
  const findings = useReviewStore(
    selectReviewAgentFindings(
      props.target,
      props.patchSignature ?? null,
      props.expectedHeadSha ?? null,
    ),
  );
  const runAgentMutation = useMutation(reviewRunAgentMutationOptions({ queryClient }));

  const { cwd, source, target } = props;
  const canRun = cwd !== null && source !== null && target !== null;
  const currentRunKey =
    cwd !== null && source !== null && target !== null
      ? `${cwd}:${reviewSourceKey(source)}:${reviewTargetKeyString(target)}:${props.expectedHeadSha ?? ""}:${props.patchSignature ?? ""}`
      : null;
  const currentRunKeyRef = useRef(currentRunKey);
  currentRunKeyRef.current = currentRunKey;

  const handleRun = () => {
    if (cwd === null || source === null || target === null) {
      return;
    }
    const submittedRunKey = currentRunKey;
    if (submittedRunKey === null) {
      return;
    }
    setStatus({ kind: "idle" });
    const providerOptions = getProviderStartOptions(settings);
    const modelSelection =
      settings.textGenerationModel && settings.textGenerationProvider
        ? ({
            provider: settings.textGenerationProvider,
            model: settings.textGenerationModel,
          } satisfies ModelSelection)
        : undefined;
    runAgentMutation.mutate(
      {
        cwd,
        source,
        ...(providerOptions ? { providerOptions } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        ...(settings.textGenerationModel
          ? { textGenerationModel: settings.textGenerationModel }
          : {}),
        ...(props.expectedHeadSha ? { expectedHeadSha: props.expectedHeadSha } : {}),
        ...(props.patchSignature ? { expectedPatchSignature: props.patchSignature } : {}),
        ...(settings.codexHomePath ? { codexHomePath: settings.codexHomePath } : {}),
      },
      {
        onSuccess: (result) => {
          if (currentRunKeyRef.current !== submittedRunKey) {
            return;
          }
          setAgentFindings(target, result);
          setStatus({
            kind: "success",
            runKey: submittedRunKey,
            summary: result.summary,
            count: result.findings.length,
            warnings: result.warnings ?? [],
          });
        },
        onError: (error) => {
          if (currentRunKeyRef.current !== submittedRunKey) {
            return;
          }
          setStatus({
            kind: "error",
            runKey: submittedRunKey,
            message: error instanceof Error ? error.message : "Agent review failed.",
          });
        },
      },
    );
  };

  const handleClear = () => {
    if (target) clearAgentFindings(target);
    setStatus({ kind: "idle" });
  };

  if (!canRun) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 bg-background",
        props.mode === "inline"
          ? "min-w-0 bg-transparent"
          : props.mode === "page"
            ? "min-h-8 border-b border-border/35 px-4 py-1"
            : props.mode === "rail"
              ? "rounded-lg border border-border/35 bg-muted/20 p-2"
              : "border-b border-border/65 px-2 py-1",
      )}
    >
      <span
        className={cn(
          "hidden min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground/80 sm:inline-flex",
          props.mode === "inline" && "sr-only",
        )}
      >
        <BotIcon className="size-3.5 shrink-0" />
        Agent
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className={cn(
          "h-7 shrink-0",
          props.mode === "page" || props.mode === "rail" || props.mode === "inline"
            ? "rounded-lg border-border/40 bg-transparent px-2.5 text-[11px] text-foreground/90 hover:bg-muted/35"
            : "rounded-lg",
        )}
        disabled={runAgentMutation.isPending}
        onClick={handleRun}
      >
        {runAgentMutation.isPending ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <BotIcon className="size-3" />
        )}
        {runAgentMutation.isPending ? "Reviewing" : "Run agent review"}
      </Button>

      {findings.length > 0 ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="shrink-0 tabular-nums"
          onClick={handleClear}
        >
          <XIcon className="size-3" />
          Clear {findings.length} finding{findings.length === 1 ? "" : "s"}
        </Button>
      ) : null}

      <RunStatusLine
        status={
          status.kind !== "idle" && status.runKey !== currentRunKey ? { kind: "idle" } : status
        }
        pending={runAgentMutation.isPending}
        compact={props.mode === "rail" || props.mode === "inline"}
      />
    </div>
  );
}

function RunStatusLine(props: { status: RunStatus; pending: boolean; compact: boolean }) {
  const { status, pending, compact } = props;
  if (pending) {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "flex flex-1 items-center gap-1.5 text-[11px] text-muted-foreground",
          compact ? "min-w-0" : "min-w-36",
        )}
      >
        <Loader2Icon className="size-3 animate-spin" />
        <span className="truncate">Scanning changed files</span>
      </span>
    );
  }
  if (status.kind === "idle") {
    return null;
  }
  if (status.kind === "error") {
    return (
      <span
        role="alert"
        className={cn(
          "flex flex-1 items-center gap-1 text-[11px] text-destructive",
          compact ? "min-w-0" : "min-w-36",
        )}
      >
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        <span className="truncate" title={status.message}>
          {status.message}
        </span>
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-1 items-center gap-1.5 text-[11px] text-muted-foreground",
        compact ? "min-w-0" : "min-w-36",
      )}
    >
      <span className="shrink-0 font-medium tabular-nums text-foreground">
        {status.count} finding{status.count === 1 ? "" : "s"}
      </span>
      {status.summary ? <span className="truncate">· {status.summary}</span> : null}
      {status.warnings.length > 0 ? (
        <span className="truncate text-warning" title={status.warnings.join("\n")}>
          · {status.warnings[0]}
        </span>
      ) : null}
    </span>
  );
}

function reviewSourceKey(source: ReviewSourceRef): string {
  if (source._tag === "pullRequest") {
    return `pullRequest:${source.reference}`;
  }
  return `branchRange:${source.base}:${source.head}`;
}
