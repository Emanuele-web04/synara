// FILE: TaskCard.tsx
// Purpose: A Hub task in a bot's thread (HoloBot's thread/TaskCard.tsx): the head (who works on
//          it, its title, when it started, its state chip), its plan as a checklist (done,
//          running, to do; long plans fold their finished lines), its latest word once it stops
//          running, then the step count with small Stop (projectAgent.resolveWorker, as the
//          Hub's own stop does) and Open (its own thread in the right pane) capsules. Without a
//          plan it shows the live step or the latest word.
// Layer: SynBot thread UI
// Exports: TaskCard, taskTone, taskStateKey

import type { Bot, HubWorkItem, HubWorkProgressStep, HubWorkState } from "@synara/contracts";
import { ProjectId, ThreadId } from "@synara/contracts";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { formatRelativeTimeAgo } from "~/lib/relativeTime";

import { BotFace, taskMood } from "../BotFace";
import { CapsuleButton, type Tone } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenTask } from "../synbotNav";
import { useStopAction } from "./useStopAction";
import { CARD_FACE, CardHead, StatusChip } from "./CardParts";
import { InlineText } from "./ChoiceParts";

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
  return (
    <svg className="steps__mark" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      {kind === "done" ? (
        <>
          <circle cx="12" cy="12" r="11" className="steps__fill" />
          <path
            d="m7.5 12 3 3 6-6.5"
            fill="none"
            className="steps__tick"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : kind === "current" ? (
        <>
          <circle cx="12" cy="12" r="10" fill="none" className="steps__ring" strokeWidth="2" />
          <circle cx="12" cy="12" r="4" className="steps__fill" />
        </>
      ) : (
        <circle cx="12" cy="12" r="10" fill="none" className="steps__ring--todo" strokeWidth="2" />
      )}
    </svg>
  );
}

export function taskTone(state: HubWorkState): Tone {
  switch (state) {
    case "starting":
    case "working":
      return "active";
    case "waiting":
      return "attention";
    case "completed":
      return "good";
    case "failed":
      return "bad";
    case "queued":
    case "idle":
    case "cancelled":
      return "muted";
  }
}

export function taskStateKey(state: HubWorkState): string {
  return `synbot:task_${state}`;
}

export function TaskCard({ task, bot }: { readonly task: HubWorkItem; readonly bot: Bot }) {
  const { t } = useTranslation();
  const openTask = useOpenTask();
  const { stopping, stop: runStop } = useStopAction();
  const running = task.state === "working" || task.state === "starting";
  const steps = task.progress?.steps ?? [];
  const done = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "inProgress")?.text ?? null;
  // Long plans keep their last few lines; the finished ones before them fold into one line.
  const firstOpen = steps.findIndex((step) => step.status !== "completed");
  const leadingDone = firstOpen === -1 ? steps.length : firstOpen;
  const hiddenDone =
    steps.length > MAX_STEPS ? Math.min(steps.length - MAX_STEPS + 1, leadingDone) : 0;
  const meta = [
    steps.length > 0 ? t("synbot:taskSteps", { done, total: steps.length }) : null,
    task.queueReason && task.state === "queued" ? task.queueReason : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const latest = task.resultSummary ?? task.progress?.summary ?? null;
  const worker = task.workerThreadId;
  const stop = () =>
    runStop(() => {
      const api = readNativeApi();
      if (!api || !worker) return undefined;
      return api.projectAgent.resolveWorker({
        requestId: `synbot-task-stop:${task.id}:${task.revision}`,
        projectId: ProjectId.makeUnsafe(bot.id),
        threadId: ThreadId.makeUnsafe(worker),
        action: "stop",
      });
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
          sub={`${bot.name} · ${formatRelativeTimeAgo(task.createdAt)}`}
          status={<StatusChip tone={taskTone(task.state)} label={t(taskStateKey(task.state))} />}
        />
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
      {steps.length > 0 && running ? null : running && current ? (
        <p className="task-card__live">
          <span className="task-card__pulse" />
          <InlineText text={current} />
        </p>
      ) : latest ? (
        <p className="task-card__text">
          <InlineText text={latest} />
        </p>
      ) : null}
      <div className="task-card__foot">
        <p className="task-card__meta">{meta}</p>
        <div className="task-card__actions">
          {ACTIVE.has(task.state) && worker ? (
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
    </article>
  );
}
