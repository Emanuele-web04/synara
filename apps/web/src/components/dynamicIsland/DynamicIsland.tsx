// FILE: DynamicIsland.tsx
// Purpose: Compact pill below the top bar showing active thread status.
// Layer: Web UI overlay (position: fixed, z-50)
// Why: Gives the user at-a-glance awareness of what the agent is doing without
//      switching to the thread's tab. Auto-expands on approvals/user-input/plans.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@synara/contracts";
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";
import { useNavigate } from "@tanstack/react-router";

import { useAppSettings } from "~/appSettings";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import {
  disclosureShellClassName,
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
} from "~/lib/disclosureMotion";
import { mapWorkLogToActionState, type ActionState } from "~/lib/actionStates";
import {
  selectActiveIslandThread,
  selectIdleIslandThread,
  selectRecentIslandThreads,
} from "~/lib/islandThreadTracker";
import { newCommandId, newMessageId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveWorkLogEntries,
  isThreadRunningTurn,
  type WorkLogEntry,
} from "~/session-logic";
import { useStore } from "~/store";
import type { Thread } from "~/types";
import { createAllThreadsSelector } from "~/storeSelectors";
import { cn } from "~/lib/utils";

const ISLAND_TOP_PX = CHAT_SURFACE_HEADER_HEIGHT_PX + 4;
const HYSTERESIS_MS = 150;
const IDLE_PILL_SIZE = 4;

type IslandMode = "compact" | "expanded" | "approval" | "user-input" | "plan" | "idle-hover";

// Hook: tracks the active island thread with hysteresis to prevent flicker.
function useIslandThreadTracker(): {
  activeThread: Thread | null;
  idleThread: Thread | null;
  recentThreads: Thread[];
} {
  const threads = useStore(useMemo(() => createAllThreadsSelector(), []));
  const [hysteresisId, setHysteresisId] = useState<string | null>(null);
  const pendingIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeSelected = useMemo(() => selectActiveIslandThread(threads), [threads]);
  const idleSelected = useMemo(() => selectIdleIslandThread(threads), [threads]);
  const recentSelected = useMemo(() => selectRecentIslandThreads(threads), [threads]);

  useEffect(() => {
    const newId = activeSelected?.id ?? null;
    if (newId === hysteresisId) {
      pendingIdRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    if (newId === null) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingIdRef.current = null;
      setHysteresisId(null);
      return;
    }

    const hasPendingState =
      activeSelected?.hasPendingApprovals === true ||
      activeSelected?.hasPendingUserInput === true ||
      activeSelected?.hasActionableProposedPlan === true;

    if (hasPendingState || hysteresisId === null) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingIdRef.current = null;
      setHysteresisId(newId);
      return;
    }

    if (pendingIdRef.current !== newId) {
      pendingIdRef.current = newId;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingIdRef.current;
        pendingIdRef.current = null;
        if (pending) setHysteresisId(pending);
      }, HYSTERESIS_MS);
    }
  }, [activeSelected, hysteresisId]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const activeThread = useMemo(
    () =>
      activeSelected?.id === hysteresisId
        ? activeSelected
        : hysteresisId
          ? (threads.find((t) => t.id === hysteresisId) ?? null)
          : null,
    [activeSelected, hysteresisId, threads],
  );

  return { activeThread, idleThread: idleSelected, recentThreads: recentSelected };
}

function useTrackedThreadActionState(
  thread: Thread | null,
  preset: ReturnType<typeof useAppSettings>["settings"]["loaderColorPreset"],
): ActionState | null {
  return useMemo(() => {
    if (!thread) return null;
    const entries = deriveWorkLogEntries(thread.activities, thread.latestTurn?.turnId ?? undefined);
    const lastEntry = entries.at(-1);
    if (!lastEntry) {
      return mapWorkLogToActionState(
        {
          id: "island-pending",
          createdAt: new Date().toISOString(),
          label: "Thinking...",
          tone: "thinking",
        } as WorkLogEntry,
        preset,
      );
    }
    return mapWorkLogToActionState(lastEntry, preset);
  }, [thread, preset]);
}

// Turn timer: shows elapsed time since turn started, updates every second.
function useTurnTimer(startedAt: string | null | undefined, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active, startedAt]);
  if (!startedAt) return null;
  const elapsed = Math.max(0, now - new Date(startedAt).getTime());
  const seconds = Math.floor(elapsed / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function DynamicIsland() {
  const { settings } = useAppSettings();
  const { activeThread, idleThread, recentThreads } = useIslandThreadTracker();
  const actionState = useTrackedThreadActionState(activeThread, settings.loaderColorPreset);

  // Window focus gating: hide island when app is not focused.
  const [windowFocused, setWindowFocused] = useState(
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Hover state: expanded on hover, collapsed on mouseleave.
  const [hovered, setHovered] = useState(false);
  const [idleHovered, setIdleHovered] = useState(false);

  // Determine island mode: priority approval > user-input > plan > activity.
  const mode: IslandMode = useMemo(() => {
    if (!activeThread) {
      return idleHovered ? "idle-hover" : "compact";
    }
    if (activeThread.hasPendingApprovals === true) return "approval";
    if (activeThread.hasPendingUserInput === true) return "user-input";
    if (activeThread.hasActionableProposedPlan === true) return "plan";
    return hovered ? "expanded" : "compact";
  }, [activeThread, hovered, idleHovered]);

  const expanded = mode !== "compact";

  if (!settings.dynamicIslandEnabled) return null;
  if (!windowFocused) return null;

  // No active thread: show tiny idle pill (hover to reveal).
  if (!activeThread || !actionState) {
    if (!idleThread) return null;
    return (
      <IdleIslandPill
        recentThreads={recentThreads}
        hovered={idleHovered}
        onHoverChange={setIdleHovered}
      />
    );
  }

  return (
    <IslandShell
      expanded={expanded}
      onHoverChange={setHovered}
      actionState={actionState}
      thread={activeThread}
    >
      {mode === "approval" && <IslandApprovalPanel thread={activeThread} />}
      {mode === "user-input" && <IslandUserInputPanel thread={activeThread} />}
      {mode === "plan" && <IslandPlanPanel thread={activeThread} />}
      {mode === "expanded" && <IslandExpandedContent thread={activeThread} />}
    </IslandShell>
  );
}

// Tiny always-visible 4px pill for idle hover.
function IdleIslandPill({
  recentThreads,
  hovered,
  onHoverChange,
}: {
  recentThreads: Thread[];
  hovered: boolean;
  onHoverChange: (v: boolean) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed left-1/2 z-50 -translate-x-1/2"
      style={{ top: ISLAND_TOP_PX }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      {hovered ? (
        <div className="pointer-events-auto rounded-lg border border-border/60 bg-background/90 p-3 shadow-lg backdrop-blur-md">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Recent threads</div>
          <div className="flex flex-col gap-1">
            {recentThreads.length === 0 ? (
              <div className="text-xs text-muted-foreground">No recent threads</div>
            ) : (
              recentThreads.map((t) => (
                <div key={t.id} className="truncate text-xs text-foreground/80" title={t.title}>
                  {t.title}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div
          className="pointer-events-auto rounded-full bg-muted-foreground/40"
          style={{ width: IDLE_PILL_SIZE * 3, height: IDLE_PILL_SIZE }}
        />
      )}
    </div>
  );
}

function IslandShell({
  expanded,
  onHoverChange,
  actionState,
  thread,
  children,
}: {
  expanded: boolean;
  onHoverChange: (v: boolean) => void;
  actionState: ActionState;
  thread: Thread;
  children: React.ReactNode;
}) {
  const Loader = actionState.loader;

  return (
    <div
      className="pointer-events-none fixed left-1/2 z-50 -translate-x-1/2"
      style={{ top: ISLAND_TOP_PX }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <div
        className={cn(
          "pointer-events-auto overflow-hidden rounded-2xl border border-border/60 bg-background/90 shadow-lg backdrop-blur-md transition-[width,border-radius] duration-220 ease-out motion-reduce:transition-none",
          expanded ? "w-[min(420px,calc(100vw-200px))]" : "w-auto rounded-full",
        )}
      >
        {/* Compact row: always visible (loader + label). */}
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Loader size={16} color={actionState.color} aria-hidden="true" />
          <span className="truncate text-xs font-medium text-foreground/90" title={thread.title}>
            {actionState.label}
          </span>
        </div>
        {/* Expanded content: height + opacity animation via disclosureMotion. */}
        <div className={disclosureShellClassName(expanded)}>
          <div className={DISCLOSURE_INNER_CLASS}>
            <div className={disclosureContentClassName(expanded)}>
              {expanded && <div className="px-3 pb-3">{children}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function IslandExpandedContent({ thread }: { thread: Thread }) {
  const entries = useMemo(
    () => deriveWorkLogEntries(thread.activities, thread.latestTurn?.turnId ?? undefined),
    [thread.activities, thread.latestTurn?.turnId],
  );
  const last4 = entries.slice(-4);
  const timer = useTurnTimer(thread.latestTurn?.startedAt, isThreadRunningTurn(thread));
  const provider = thread.session?.provider ?? thread.modelSelection.provider;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider} className="size-4 shrink-0" />
        <span className="truncate text-xs font-semibold text-foreground" title={thread.title}>
          {thread.title}
        </span>
        {timer && <span className="ml-auto text-xs text-muted-foreground">{timer}</span>}
      </div>
      <div className="flex flex-col gap-1">
        {last4.map((entry) => (
          <div
            key={entry.id}
            className="truncate text-xs text-muted-foreground"
            title={entry.label}
          >
            {entry.label}
          </div>
        ))}
      </div>
      <IslandMiniChat thread={thread} />
    </div>
  );
}

// Mini chat: direct dispatchCommand, text-only, sources runtime/interaction/model
// from tracked thread for fidelity. queue mode (starts new turn when idle, queues when running).
function IslandMiniChat({ thread }: { thread: Thread }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const api = readNativeApi();
    if (!api) {
      setError("Not connected");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: thread.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: trimmed,
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        dispatchMode: "queue",
        createdAt: new Date().toISOString(),
      });
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 border-t border-border/40 pt-2">
      <div className="flex gap-1">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Send a message..."
          className="flex-1 rounded-md border border-border/40 bg-background/60 px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <Button
          size="sm"
          variant="default"
          disabled={sending || !text.trim()}
          onClick={() => void send()}
        >
          Send
        </Button>
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}

// Priority: approval > user-input > plan > activity.
// Approval: 2x2 button grid, sequential display for multiple approvals.
function IslandApprovalPanel({ thread }: { thread: Thread }) {
  const approvals = useMemo(() => derivePendingApprovals(thread.activities), [thread.activities]);
  const [respondingIds, setRespondingIds] = useState<Set<string>>(new Set());

  if (approvals.length === 0) return null;
  const current = approvals[0]!;

  const onRespond = async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
    const api = readNativeApi();
    if (!api) return;
    setRespondingIds((prev) => new Set(prev).add(requestId));
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.approval.respond",
        commandId: newCommandId(),
        threadId: thread.id,
        requestId,
        decision,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Error is shown via thread.error state
    } finally {
      setRespondingIds((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold text-foreground">
        {current.requestKind === "command"
          ? "Command approval"
          : current.requestKind === "file-read"
            ? "File read approval"
            : "File change approval"}
        {approvals.length > 1 && (
          <span className="ml-1 text-muted-foreground">
            ({1}/{approvals.length})
          </span>
        )}
      </div>
      {current.detail && (
        <div
          className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground"
          title={current.detail}
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-[10px]">
            {current.detail}
          </pre>
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={respondingIds.has(current.requestId)}
          onClick={() => void onRespond(current.requestId, "cancel")}
        >
          Cancel turn
        </Button>
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={respondingIds.has(current.requestId)}
          onClick={() => void onRespond(current.requestId, "decline")}
        >
          Decline
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={respondingIds.has(current.requestId)}
          onClick={() => void onRespond(current.requestId, "acceptForSession")}
        >
          Always allow
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={respondingIds.has(current.requestId)}
          onClick={() => void onRespond(current.requestId, "accept")}
        >
          Approve once
        </Button>
      </div>
    </div>
  );
}

function IslandUserInputPanel({ thread }: { thread: Thread }) {
  const userInputs = useMemo(() => derivePendingUserInputs(thread.activities), [thread.activities]);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [responding, setResponding] = useState(false);

  if (userInputs.length === 0) return null;
  const current = userInputs[0]!;

  const onRespond = async () => {
    const api = readNativeApi();
    if (!api) return;
    setResponding(true);
    try {
      const dispatchAnswers = Object.fromEntries(
        current.questions.map((q) => [q.id, answers[q.id] ?? null]),
      ) as ProviderUserInputAnswers;
      await api.orchestration.dispatchCommand({
        type: "thread.user-input.respond",
        commandId: newCommandId(),
        threadId: thread.id,
        requestId: current.requestId,
        answers: dispatchAnswers,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Error shown via thread state
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {current.questions.map((q: UserInputQuestion) => (
        <div key={q.id} className="flex flex-col gap-1">
          <div className="text-xs font-medium text-foreground">{q.question}</div>
          <div className="flex flex-col gap-1">
            {q.options.map((opt) => {
              const selected = q.multiSelect
                ? (answers[q.id] as string[] | undefined)?.includes(opt.label)
                : answers[q.id] === opt.label;
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={cn(
                    "rounded-md border px-2 py-1 text-left text-xs transition-colors",
                    selected
                      ? "border-accent bg-accent/10 text-foreground"
                      : "border-border/40 bg-background/40 text-muted-foreground hover:bg-muted/40",
                  )}
                  onClick={() => {
                    setAnswers((prev) => {
                      const next = { ...prev };
                      if (q.multiSelect) {
                        const arr = (next[q.id] as string[] | undefined) ?? [];
                        next[q.id] = arr.includes(opt.label)
                          ? arr.filter((l) => l !== opt.label)
                          : [...arr, opt.label];
                      } else {
                        next[q.id] = opt.label;
                      }
                      return next;
                    });
                  }}
                >
                  <div className="font-medium">{opt.label}</div>
                  {opt.description && (
                    <div className="text-[10px] text-muted-foreground">{opt.description}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <Button size="sm" variant="default" disabled={responding} onClick={() => void onRespond()}>
        Submit
      </Button>
    </div>
  );
}

function IslandPlanPanel({ thread }: { thread: Thread }) {
  const navigate = useNavigate();
  const plan = thread.proposedPlans.at(-1);
  if (!plan) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold text-foreground">Plan proposed</div>
      <div className="line-clamp-3 text-xs text-muted-foreground">{plan.planMarkdown}</div>
      <Button
        size="sm"
        variant="default"
        onClick={() => void navigate({ to: "/$threadId", params: { threadId: thread.id } })}
      >
        View plan
      </Button>
    </div>
  );
}

// Re-export for testing
export { useIslandThreadTracker, useTrackedThreadActionState };
