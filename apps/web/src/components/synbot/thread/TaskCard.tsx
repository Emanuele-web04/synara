// FILE: TaskCard.tsx
// Purpose: A Hub task in a bot's thread (HoloBot's thread/TaskCard.tsx): the head (who works on
//          it, its title, when it started, its state chip), its plan as a checklist (done,
//          running, to do; long plans fold their finished lines), its latest word once it stops
//          running, then the step count (or why it is queued) with small Stop
//          (projectAgent.resolveWorker, as the Hub's own stop does) and Open (its own thread in
//          the right pane) capsules. Without a plan it shows the live step while it runs (the
//          worker's progress line, else its thread's newest tool step) or the latest word.
// Layer: SynBot thread UI
// Exports: TaskCard

import type { Bot, HubWorkItem, HubWorkProgressStep, HubWorkState } from "@synara/contracts";
import { ProjectId, ThreadId } from "@synara/contracts";
import { useMemo } from "react";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { latestWorkStep } from "~/synbot/botThread.logic";
import { deriveWorkLogEntries, type TimelineEntry } from "~/workLog";

import { BotFace, taskMood } from "../BotFace";
import { CapsuleButton } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenTask } from "../synbotNav";
import { useStopAction } from "./useStopAction";
import { CARD_FACE, CardHead, StatusChip, StatusMark, useTimeAgo } from "./CardParts";
import { InlineText } from "./ChoiceParts";
import { queueReasonKey, taskStateKey, taskTone } from "./stateWords";

const ACTIVE: ReadonlySet<HubWorkState> = new Set(["queued", "starting", "working", "waiting"]);

/** Checklist lines a card shows before the finished ones fold into "N earlier steps done". */
const MAX_STEPS = 6;

type StepStatus = HubWorkProgressStep["status"];

function stepClass(status: StepStatus): "done" | "current" | "todo" {
  return status === "completed" ? "done" : status === "inProgress" ? "current" : "todo";
}

/** A checklist mark: filled check when done, a ring with a dot while running, an empty ring. */
function StepMark({ status }: { readonly status: StepStatus }) {
  const kind = stepClass(status);
  return kind === "done" ? (
    <StatusMark shape="check" />
  ) : kind === "current" ? (
    <StatusMark shape="dot" />
  ) : (
    <StatusMark shape="ring" tone="muted" />
  );
}

/** The worker thread's newest tool step while it runs, when its activity is loaded (read only
 * for a running task without a plan or a progress line; no subscription of its own). */
function useWorkerStep(threadId: ThreadId | null, enabled: boolean): string | null {
  const ids = useStore((state) =>
    enabled && threadId ? (state.activityIdsByThreadId?.[threadId] ?? null) : null,
  );
  const byId = useStore((state) =>
    enabled && threadId ? (state.activityByThreadId?.[threadId] ?? null) : null,
  );
  const activeTurnId = useStore((state) =>
    enabled && threadId ? (state.threadSessionById?.[threadId]?.activeTurnId ?? null) : null,
  );
  return useMemo(() => {
    if (!ids || !byId || !activeTurnId) return null;
    const activities = ids.flatMap((id) => (byId[id] ? [byId[id]] : []));
    const entries: TimelineEntry[] = deriveWorkLogEntries(activities, activeTurnId, {
      activeTurnId,
      latestTurnState: "running",
    }).map((entry) => ({ id: entry.id, kind: "work", createdAt: entry.createdAt, entry }));
    return latestWorkStep(entries, activeTurnId);
  }, [ids, byId, activeTurnId]);
}

export function TaskCard({ task, bot }: { readonly task: HubWorkItem; readonly bot: Bot }) {
  const { t } = useTranslation();
  const openTask = useOpenTask();
  const { stopping, stop: runStop } = useStopAction();
  const running = task.state === "working" || task.state === "starting";
  const steps = task.progress?.steps ?? [];
  const done = steps.filter((step) => step.status === "completed").length;
  const worker = task.workerThreadId;
  const progressLine = task.progress?.summary?.trim() || null;
  const workerStep = useWorkerStep(worker, running && steps.length === 0 && !progressLine);
  // Without a plan, what it is doing now: its own progress line, else its newest tool step.
  const live = running && steps.length === 0 ? (progressLine ?? workerStep) : null;
  // Long plans keep their last few lines; the finished ones before them fold into one line.
  const firstOpen = steps.findIndex((step) => step.status !== "completed");
  const leadingDone = firstOpen === -1 ? steps.length : firstOpen;
  const hiddenDone =
    steps.length > MAX_STEPS ? Math.min(steps.length - MAX_STEPS + 1, leadingDone) : 0;
  const reasonKey = task.state === "queued" ? queueReasonKey(task.queueReason) : null;
  const meta = [
    steps.length > 0 ? t("synbot:taskSteps", { done, total: steps.length }) : null,
    // The chip already says Queued: only a known reason adds a line.
    reasonKey && reasonKey !== taskStateKey("queued") ? t(reasonKey) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const latest = task.resultSummary ?? task.progress?.summary ?? null;
  const when = useTimeAgo(task.createdAt);
  // Nothing to stop and nothing to count: no foot, so a finished task is one compact card
  // whose head opens it (an arrow says so), not a head over an empty rule.
  const hasFoot = ACTIVE.has(task.state) || meta.length > 0;
  const stop = () =>
    runStop(() => {
      const api = readNativeApi();
      if (!api) return undefined;
      if (worker) {
        return api.projectAgent.resolveWorker({
          requestId: `synbot-task-stop:${task.id}:${task.revision}`,
          projectId: ProjectId.makeUnsafe(bot.id),
          threadId: ThreadId.makeUnsafe(worker),
          action: "stop",
        });
      }
      return api.bots.stopAll({ botId: bot.id, taskId: task.id });
    });
  return (
    <article className="task-card">
      <button
        type="button"
        className="task-card__head"
        title={t("synbot:openTask")}
        disabled={!worker}
        onClick={() => worker && openTask(worker)}
      >
        <CardHead
          faces={<BotFace bot={bot} size={CARD_FACE} mood={taskMood(task.state)} />}
          title={task.title}
          sub={`${bot.name} · ${when}`}
          status={<StatusChip tone={taskTone(task.state)} label={t(taskStateKey(task.state))} />}
        />
        {!hasFoot && worker ? (
          <span className="task-card__go">
            <Icon name="arrow-right" size="xs" />
          </span>
        ) : null}
      </button>
      {steps.length > 0 ? (
        <ol className="steps" aria-label={t("synbot:taskSteps", { done, total: steps.length })}>
          {hiddenDone > 0 ? (
            <li className="steps__item steps__item--done">
              <StepMark status="completed" />
              <span className="steps__text">
                {t("synbot:stepsEarlierDone", { count: hiddenDone })}
              </span>
            </li>
          ) : null}
          {steps.slice(hiddenDone).map((step) => (
            <li key={step.id} className={`steps__item steps__item--${stepClass(step.status)}`}>
              <StepMark status={step.status} />
              <span className="steps__text">
                <InlineText text={step.text} />
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {steps.length > 0 && running ? null : live ? (
        <p className="task-card__live">
          <span className="task-card__pulse" />
          <span className="task-card__live-text">
            <InlineText text={live} />
          </span>
        </p>
      ) : latest && !running ? (
        <p className="task-card__text">
          <InlineText text={latest} />
        </p>
      ) : null}
      {hasFoot ? (
        <div className="task-card__foot">
          <p className="task-card__meta">{meta}</p>
          <div className="task-card__actions">
            {ACTIVE.has(task.state) ? (
              <CapsuleButton kind="danger" small disabled={stopping} onClick={stop}>
                {t("synbot:stop")}
              </CapsuleButton>
            ) : null}
            {worker ? (
              <CapsuleButton kind="card" small onClick={() => openTask(worker)}>
                {t("synbot:open")}
                <Icon name="arrow-right" size="xs" />
              </CapsuleButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}
