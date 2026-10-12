import type { ProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";
import {
  ModelSelection,
  CommandId,
  type OrchestrationStartParallelRunInput,
  type ProviderKind,
  type ModelSlug,
  type ThreadId,
  type OrchestrationThread,
  type ClientOrchestrationCommand,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useMemo, useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useTemporaryThreadStore } from "~/temporaryThreadStore";

import type { Thread, Project } from "~/types";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import { buildDraftThreadRenameCreateInput } from "~/lib/threadRename";
import {
  parallelAttemptSettled,
  parallelComparisonPrompt,
  selectParallelRunAttempt,
} from "~/lib/parallelRuns";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ComponentProps } from "react";

type PickerProps = ComponentProps<typeof ProviderModelPicker>;

export function ParallelRunsControl(props: {
  thread: Thread;
  project: Project;
  selection: ModelSelection;
  picker: Pick<
    PickerProps,
    | "providers"
    | "modelOptionsByProvider"
    | "modelOptionsByProviderInstance"
    | "providerInstances"
    | "loadingModelProviders"
    | "discoveryErrorsByProvider"
  >;
  catalog?: Pick<
    ProviderModelCatalog,
    "runtimeModelsByProvider" | "runtimeModelsByProviderInstance"
  >;
  onNavigate: (id: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [comparison, setComparison] = useState<{
    create: Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
    start: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
  } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [selections, setSelections] = useState<ModelSelection[]>([
    props.selection,
    props.selection,
  ]);
  const [request, setRequest] = useState<OrchestrationStartParallelRunInput | null>(null);
  const [sourcePromotion, setSourcePromotion] = useState<Extract<
    ClientOrchestrationCommand,
    { type: "thread.create" }
  > | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaries = useStore((state) => state.sidebarThreadSummaryById);
  const runId = props.thread.parallelRun?.runId;
  const attempts = useMemo(
    () =>
      runId
        ? Object.values(summaries)
            .filter((thread) => thread.parallelRun?.runId === runId)
            .toSorted((a, b) => a.parallelRun!.index - b.parallelRun!.index)
        : [],
    [summaries, runId],
  );
  const details = useQuery({
    queryKey: ["parallel-run", runId, attempts.map((thread) => thread.id)],
    enabled: open && !!runId,
    queryFn: async () => {
      const api = ensureNativeApi();
      const result = [];
      for (const thread of attempts) {
        const detail = await api.orchestration.getThreadDetailSnapshot({ threadId: thread.id });
        const diff = thread.worktreePath
          ? await api.git
              .readWorkingTreeDiff({
                cwd: thread.worktreePath,
                scope: "ref",
                compareRef: thread.parallelRun!.baseCommit,
              })
              .catch(() => null)
          : null;
        result.push({ thread: detail?.thread ?? null, diff });
      }
      return result;
    },
    refetchInterval: open && runId ? 3_000 : false,
  });
  const incompleteLaunch =
    !!props.thread.parallelRun?.request &&
    (attempts.length !== props.thread.parallelRun.count ||
      attempts.some((attempt) => !attempt.latestTurn && !attempt.session));
  const settled =
    attempts.length === props.thread.parallelRun?.count && attempts.every(parallelAttemptSettled);
  const perform = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const launch = () =>
    perform(async () => {
      const input = request ?? {
        runId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        sourceThreadId: props.thread.id,
        runtimeMode: props.thread.runtimeMode,
        interactionMode: props.thread.interactionMode,
        prompt: prompt.trim(),
        attempts: selections,
      };
      setRequest(input);
      const source = sourcePromotion ?? {
        ...buildDraftThreadRenameCreateInput(props.thread),
        type: "thread.create" as const,
        commandId: CommandId.makeUnsafe(`parallel:${input.runId}:source`),
        threadId: props.thread.id,
        title: props.thread.title,
      };
      setSourcePromotion(source);
      const drafts = useComposerDraftStore.getState();
      if (drafts.draftThreadsByThreadId[props.thread.id])
        drafts.setDraftThreadContext(props.thread.id, { isTemporary: false });
      useTemporaryThreadStore.getState().clearTemporaryThread(props.thread.id);
      await promoteThreadCreate(source, ensureNativeApi());
      const result = await ensureNativeApi().orchestration.startParallelRun(input);
      setOpen(false);
      setRequest(null);
      setSourcePromotion(null);
      props.onNavigate(result.threadIds[0]!);
    });
  const compare = () =>
    perform(async () => {
      const api = ensureNativeApi();
      let operation = comparison;
      if (!operation) {
        const threads: OrchestrationThread[] = [];
        for (const attempt of attempts) {
          const detail = await api.orchestration.getThreadDetailSnapshot({ threadId: attempt.id });
          if (!detail?.thread || !parallelAttemptSettled(detail.thread))
            throw new Error("Wait for all attempt details to settle before comparing.");
          threads.push(detail.thread);
        }
        if (threads.length !== props.thread.parallelRun?.count)
          throw new Error("Wait for every attempt to load.");
        const id = newThreadId();
        const createdAt = new Date().toISOString();
        operation = {
          create: {
            type: "thread.create",
            commandId: newCommandId(),
            threadId: id,
            projectId: props.project.id,
            title: "Compare parallel attempts",
            modelSelection: props.selection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            envMode: "local",
            branch: null,
            worktreePath: null,
            createdAt,
          },
          start: {
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId: id,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: parallelComparisonPrompt(threads),
              attachments: [],
            },
            modelSelection: props.selection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt,
          },
        };
        setComparison(operation);
      }
      await api.orchestration.dispatchCommand(operation.create);
      await api.orchestration.dispatchCommand(operation.start);
      setComparison(null);
      setOpen(false);
      props.onNavigate(operation.create.threadId);
    });
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          if (!runId && !request && !prompt) {
            setSelections([props.selection, props.selection]);
          }
          setOpen(true);
        }}
      >
        {runId ? "Compare attempts" : "Parallel run"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogPopup className={runId ? "max-w-5xl" : undefined}>
          <DialogHeader>
            <DialogTitle>
              {runId ? "Parallel attempts" : "Run the same task in parallel"}
            </DialogTitle>
            <DialogDescription>
              {runId
                ? "Inspect each answer and its changes from the common base. Keeping an attempt archives the other conversations and preserves their branches and worktrees."
                : "Choose two or three attempts. Each gets an independent thread and worktree from the same commit. Uncommitted source changes are excluded. The source conversation is kept for launch recovery. Its access mode applies to every attempt. Providers without Auto support use approval mode."}
            </DialogDescription>
          </DialogHeader>
          {runId ? (
            <div
              className={`grid gap-3 overflow-auto p-4 text-ui ${attempts.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
            >
              {attempts.map((attempt, index) => (
                <section key={attempt.id} className="min-w-0 rounded-lg border p-3">
                  <h3 className="font-medium">
                    Attempt {attempt.parallelRun!.index + 1} · {attempt.modelSelection.model}
                  </h3>
                  <p className="break-all text-ui-xs text-muted-foreground">{attempt.branch}</p>
                  <p>
                    {attempt.archivedAt
                      ? "Archived"
                      : (attempt.latestTurn?.state ??
                        (attempt.session?.status === "error" ? "Failed to start" : "Starting"))}
                  </p>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-sans">
                    {details.data?.[index]?.thread?.messages.findLast(
                      (message) => message.role === "assistant",
                    )?.text ??
                      (parallelAttemptSettled(attempt)
                        ? "No final answer recorded."
                        : "Waiting for an answer…")}
                  </pre>
                  <details className="my-2">
                    <summary>Changes from base</summary>
                    <pre className="max-h-64 overflow-auto text-ui-xs">
                      {details.data?.[index]?.diff?.patch || "No diff available."}
                    </pre>
                    {details.data?.[index]?.diff?.truncated ? (
                      <p>Diff truncated; open the attempt to inspect all changes.</p>
                    ) : null}
                  </details>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setOpen(false);
                        props.onNavigate(attempt.id);
                      }}
                    >
                      Open
                    </Button>
                    <Button
                      size="sm"
                      disabled={!settled || pending || !!attempt.archivedAt}
                      onClick={() =>
                        void perform(async () => {
                          await selectParallelRunAttempt(ensureNativeApi(), runId, attempt.id);
                          setOpen(false);
                          props.onNavigate(attempt.id);
                        })
                      }
                    >
                      Keep this attempt
                    </Button>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="space-y-3 p-4">
              <Textarea
                aria-label="Task for every attempt"
                value={prompt}
                disabled={pending || !!request}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the task for every model…"
              />
              {selections.map((selection, index) => (
                <div key={`attempt-${index + 1}`} className="flex items-center gap-2 text-ui">
                  <span>Attempt {index + 1}</span>
                  <ProviderModelPicker
                    {...props.picker}
                    provider={selection.provider}
                    model={selection.model as ModelSlug}
                    {...(selection.instanceId
                      ? { selectedProviderInstanceId: selection.instanceId }
                      : {})}
                    lockedProvider={null}
                    disabled={pending || !!request}
                    onProviderModelChange={(provider: ProviderKind, model, instanceId) =>
                      setSelections((values) =>
                        values.map((value, slot) =>
                          slot === index
                            ? Schema.decodeUnknownSync(ModelSelection)({
                                provider,
                                model,
                                instanceId: instanceId ?? provider,
                                ...(provider === "claudeAgent"
                                  ? {
                                      supportsAutoMode: resolveRuntimeModelDescriptor({
                                        provider,
                                        model,
                                        runtimeModels:
                                          props.catalog?.runtimeModelsByProviderInstance[
                                            instanceId ?? provider
                                          ] ?? props.catalog?.runtimeModelsByProvider[provider],
                                      })?.supportsAutoMode,
                                    }
                                  : {}),
                                ...(provider === value.provider && value.options
                                  ? { options: value.options }
                                  : {}),
                              })
                            : value,
                        ),
                      )
                    }
                  />
                </div>
              ))}
              <Button
                variant="outline"
                disabled={pending || !!request}
                onClick={() =>
                  setSelections((values) =>
                    values.length === 2 ? [...values, props.selection] : values.slice(0, 2),
                  )
                }
              >
                {selections.length === 2 ? "Add third attempt" : "Remove third attempt"}
              </Button>
              <p className="text-ui-xs text-muted-foreground">
                Current model settings are copied for matching providers.
              </p>
            </div>
          )}
          {error || details.error ? (
            <p role="alert" className="px-4 text-ui text-destructive">
              {error ?? String(details.error)}
            </p>
          ) : null}
          <DialogFooter>
            {runId ? (
              <>
                {incompleteLaunch ? (
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void perform(async () => {
                        const recovered = await ensureNativeApi().orchestration.startParallelRun(
                          props.thread.parallelRun!.request!,
                        );
                        await details.refetch();
                        setOpen(false);
                        props.onNavigate(recovered.threadIds[0]!);
                      })
                    }
                  >
                    Resume launch
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={pending || settled}
                  onClick={() =>
                    void perform(async () => {
                      for (const attempt of attempts)
                        await ensureNativeApi().orchestration.dispatchCommand({
                          type: "thread.turn.interrupt",
                          commandId: newCommandId(),
                          threadId: attempt.id,
                          createdAt: new Date().toISOString(),
                        });
                    })
                  }
                >
                  Stop all attempts
                </Button>
                <Button
                  disabled={pending || (!comparison && (!settled || !details.data))}
                  onClick={() => void compare()}
                >
                  Compare in new thread
                </Button>
              </>
            ) : (
              <>
                {request ? (
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setRequest(null);
                      setError(null);
                    }}
                  >
                    Start a new run
                  </Button>
                ) : null}
                <Button disabled={pending || !prompt.trim()} onClick={() => void launch()}>
                  {pending
                    ? "Starting…"
                    : request
                      ? "Retry same run"
                      : `Start ${selections.length} attempts`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
