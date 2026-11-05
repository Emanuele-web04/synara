// FILE: TaskCard.tsx
// Purpose: A Hub task in a bot's thread (HoloBot's thread/TaskCard.tsx): who works on it, its
//          title and state, when it started and how far its checklist is, what is happening now
//          (the live step) or its latest word (the result), then Open (its own thread in the
//          right pane) and Stop (projectAgent.resolveWorker, as the Hub's own stop does).
// Layer: SynBot thread UI
// Exports: TaskCard, taskTone, taskStateKey

import type { Bot, HubWorkItem, HubWorkState } from "@synara/contracts";
import { ProjectId, ThreadId } from "@synara/contracts";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { formatRelativeTimeAgo } from "~/lib/relativeTime";

import { toastManager } from "../../ui/toast";
import { BotFace } from "../BotFace";
import { CapsuleButton, Chip, type Tone } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenTask } from "../synbotNav";
import { InlineText } from "./ChoiceParts";

const ACTIVE: ReadonlySet<HubWorkState> = new Set(["queued", "starting", "working", "waiting"]);

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
  const [stopping, setStopping] = useState(false);
  const running = task.state === "working" || task.state === "starting";
  const steps = task.progress?.steps ?? [];
  const done = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "inProgress")?.text ?? null;
  const meta = [
    formatRelativeTimeAgo(task.createdAt),
    steps.length > 0 ? t("synbot:taskSteps", { done, total: steps.length }) : null,
    task.queueReason && task.state === "queued" ? task.queueReason : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const latest = task.resultSummary ?? task.progress?.summary ?? null;
  const worker = task.workerThreadId;
  const stop = () => {
    const api = readNativeApi();
    if (!api || !worker) return;
    setStopping(true);
    void api.projectAgent
      .resolveWorker({
        requestId: `synbot-task-stop:${task.id}:${task.revision}`,
        projectId: ProjectId.makeUnsafe(bot.id),
        threadId: ThreadId.makeUnsafe(worker),
        action: "stop",
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:stopFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setStopping(false));
  };
  return (
    <article className="task-card">
      <button
        type="button"
        className="task-card__head"
        title={t("synbot:openTask")}
        disabled={!worker}
        onClick={() => worker && openTask(worker)}
      >
        <BotFace bot={bot} size="card" mood={running ? "working" : "idle"} />
        <span className="task-card__title">{task.title}</span>
        <Chip tone={taskTone(task.state)}>{t(taskStateKey(task.state))}</Chip>
      </button>
      {meta ? <p className="task-card__meta">{meta}</p> : null}
      {running && current ? (
        <p className="task-card__live">
          <span className="task-card__pulse" />
          <InlineText text={current} />
        </p>
      ) : latest ? (
        <p className="task-card__text">
          <InlineText text={latest} />
        </p>
      ) : null}
      <div className="task-card__actions">
        {worker ? (
          <CapsuleButton kind="ghost" small onClick={() => openTask(worker)}>
            {t("synbot:open")}
            <Icon name="arrow-right" size="xs" />
          </CapsuleButton>
        ) : null}
        {ACTIVE.has(task.state) && worker ? (
          <CapsuleButton kind="ghost" small disabled={stopping} onClick={stop}>
            {t("synbot:stop")}
          </CapsuleButton>
        ) : null}
      </div>
    </article>
  );
}
