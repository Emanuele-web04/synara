import { ThreadId, type OrchestrationEvent, type ServerConfig } from "@t3tools/contracts";
import { defaultTerminalTitleForCliKind } from "@t3tools/shared/terminalThreads";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { APP_DISPLAY_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { clearPromotedDraftThreads, useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { terminalActivityFromEvent } from "../terminalActivity";
import {
  onServerConfigUpdated,
  onServerProviderStatusesUpdated,
  onServerWelcome,
} from "../wsNativeApi";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { TaskCompletionNotifications } from "../notifications/taskCompletion";
import { useWorkspaceStore, workspaceThreadId } from "../workspaceStore";
import { useAppTypography } from "../hooks/useAppTypography";
import { invalidateGitQueries } from "../lib/gitReactQuery";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  useAppTypography();

  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EventRouter />
        <TaskCompletionNotifications />
        <DesktopProjectBootstrap />
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

const SNAPSHOT_CATCH_UP_MAX_ATTEMPTS = 5;
const SNAPSHOT_CATCH_UP_DELAY_MS = 40;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function EventRouter() {
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const setWorkspaceHomeDir = useWorkspaceStore((store) => store.setHomeDir);
  const workspacePages = useWorkspaceStore((store) => store.workspacePages);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pathnameRef = useRef(pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);

  pathnameRef.current = pathname;

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let latestSequence = 0;
    let syncing = false;
    let pending = false;
    let needsProviderInvalidation = false;
    let needsGitInvalidation = false;
    let pendingDomainEvents: OrchestrationEvent[] = [];

    const removeOrphanedTerminalsForCurrentState = () => {
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: useStore
          .getState()
          .threads.map((thread) => ({
            id: thread.id,
            deletedAt: null,
            archivedAt: thread.archivedAt ?? null,
          })),
        draftThreadIds,
        retainedThreadIds: workspacePages.map((workspace) => workspaceThreadId(workspace.id)),
      });
      removeOrphanedTerminalStates(activeThreadIds);
    };

    const flushSnapshotSync = async (): Promise<void> => {
      let snapshot = await api.orchestration.getSnapshot();
      if (disposed) return;
      // Domain events can reach the client before the projection snapshot catches up.
      // Wait briefly for the snapshot cursor so late turn-diff summaries do not disappear
      // until the next user message or a manual refresh.
      for (
        let attempt = 1;
        snapshot.snapshotSequence < latestSequence && attempt < SNAPSHOT_CATCH_UP_MAX_ATTEMPTS;
        attempt += 1
      ) {
        await wait(SNAPSHOT_CATCH_UP_DELAY_MS * attempt);
        if (disposed) return;
        snapshot = await api.orchestration.getSnapshot();
        if (disposed) return;
      }
      if (snapshot.snapshotSequence < latestSequence) {
        pending = true;
        return;
      }
      latestSequence = Math.max(latestSequence, snapshot.snapshotSequence);
      syncServerReadModel(snapshot);
      clearPromotedDraftThreads(new Set(snapshot.threads.map((t) => t.id)));
      removeOrphanedTerminalsForCurrentState();
      if (pending) {
        pending = false;
        await flushSnapshotSync();
      }
    };

    const syncSnapshot = async () => {
      if (syncing) {
        pending = true;
        return;
      }
      syncing = true;
      pending = false;
      try {
        await flushSnapshotSync();
      } catch {
        // Keep prior state and wait for the next domain event to trigger a resync.
      }
      syncing = false;
      if (pending) {
        pending = false;
        void syncSnapshot();
      }
    };

    const domainEventFlushThrottler = new Throttler(
      () => {
        if (pendingDomainEvents.length > 0) {
          applyOrchestrationEvents(coalesceOrchestrationUiEvents(pendingDomainEvents));
          pendingDomainEvents = [];
        }
        if (needsProviderInvalidation) {
          needsProviderInvalidation = false;
          void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
          // Invalidate workspace entry queries so the @-mention file picker
          // reflects files created, deleted, or restored during this turn.
          void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
        }
        if (needsGitInvalidation) {
          needsGitInvalidation = false;
          void invalidateGitQueries(queryClient);
        }
        void syncSnapshot();
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
      if (event.sequence <= latestSequence) {
        return;
      }
      latestSequence = event.sequence;
      pendingDomainEvents.push(event);
      if (event.type === "thread.turn-diff-completed" || event.type === "thread.reverted") {
        needsProviderInvalidation = true;
      }
      if (
        event.type === "thread.meta-updated" &&
        (event.payload.branch !== undefined ||
          event.payload.envMode !== undefined ||
          event.payload.worktreePath !== undefined ||
          event.payload.associatedWorktreePath !== undefined ||
          event.payload.associatedWorktreeBranch !== undefined ||
          event.payload.associatedWorktreeRef !== undefined)
      ) {
        needsGitInvalidation = true;
      }
      domainEventFlushThrottler.maybeExecute();
    });
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const terminalThreadId = ThreadId.makeUnsafe(event.threadId);
      if (event.type === "activity") {
        if (event.cliKind) {
          useTerminalStateStore.getState().setTerminalMetadata(terminalThreadId, event.terminalId, {
            cliKind: event.cliKind,
            label: defaultTerminalTitleForCliKind(event.cliKind),
          });
        }
      }
      const activity = terminalActivityFromEvent(event);
      if (activity === null) {
        return;
      }
      useTerminalStateStore.getState().setTerminalActivity(terminalThreadId, event.terminalId, {
        hasRunningSubprocess: activity.hasRunningSubprocess,
        agentState: activity.agentState,
      });
    });
    const unsubWelcome = onServerWelcome((payload) => {
      void (async () => {
        setWorkspaceHomeDir(payload.homeDir);
        await syncSnapshot();
        if (disposed) {
          return;
        }

        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        setProjectExpanded(payload.bootstrapProjectId, true);

        if (pathnameRef.current !== "/") {
          return;
        }
        if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: payload.bootstrapThreadId },
          replace: true,
        });
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
      })().catch(() => undefined);
    });
    // onServerConfigUpdated replays the latest cached value synchronously
    // during subscribe. Skip the toast for that replay so effect re-runs
    // don't produce duplicate toasts.
    let subscribed = false;
    const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
      if (!subscribed) return;
      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    });
    const unsubProviderStatusesUpdated = onServerProviderStatusesUpdated((payload) => {
      const currentConfig = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
      if (!currentConfig) {
        void queryClient.fetchQuery(serverConfigQueryOptions()).catch(() => undefined);
        return;
      }
      queryClient.setQueryData(serverQueryKeys.config(), {
        ...currentConfig,
        providers: payload.providers,
      });
    });
    subscribed = true;
    return () => {
      disposed = true;
      needsProviderInvalidation = false;
      domainEventFlushThrottler.cancel();
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
      unsubProviderStatusesUpdated();
    };
  }, [
    applyOrchestrationEvents,
    navigate,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    setWorkspaceHomeDir,
    syncServerReadModel,
    workspacePages,
  ]);

  return null;
}

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
