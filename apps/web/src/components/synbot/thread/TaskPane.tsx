// FILE: TaskPane.tsx
// Purpose: A task's own thread in the right pane (HoloBot's right-pane ThreadPane with
//          TaskBar): back to the bot's thread, the face of the bot that works on it and its
//          title, close; under it the state, when it started and its pull request; the merge
//          proof when that setting is on; then the worker's thread itself in Synara's chat view
//          (tool work, diffs and follow-ups as in any Synara thread).
// Layer: SynBot thread UI
// Exports: TaskPane

import type { Bot, HubWorkItem, ThreadId } from "@synara/contracts";
import { useEffect } from "react";

import { useTranslation } from "~/i18n";
import { formatRelativeTimeAgo } from "~/lib/relativeTime";
import type { SplitViewPanePanelState } from "~/splitViewStore";
import { useStore } from "~/store";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";

import { DeferredChatView, noopChatSurfaceAction } from "../../chat/ChatThreadSurfacePrimitives";
import { BotFace } from "../BotFace";
import { Chip, IconButton, Pane, Strip, Text } from "../kit/controls";
import { useOpenTask } from "../synbotNav";
import { ProofCard } from "./ProofCard";
import { taskStateKey, taskTone } from "./TaskCard";
import "./thread.css";

const EMBEDDED_PANEL_STATE: SplitViewPanePanelState = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "browser",
};

export function TaskPane({
  threadId,
  task,
  bot,
  showProof,
}: {
  readonly threadId: ThreadId;
  readonly task: HubWorkItem | null;
  readonly bot: Bot | null;
  readonly showProof: boolean;
}) {
  const { t } = useTranslation();
  const openTask = useOpenTask();
  useEffect(() => retainThreadDetailSubscription(threadId), [threadId]);
  const title = useStore(
    (state) => task?.title ?? state.threadShellById?.[threadId]?.title ?? t("synbot:task"),
  );
  const pr = useStore((state) => state.threadShellById?.[threadId]?.lastKnownPr?.url ?? null);
  return (
    <Pane width="sessions" edge="left" className="task-pane">
      <Strip
        className="task-bar"
        leading={
          <>
            <IconButton
              icon="arrow-left"
              kind="ghost"
              label={t("synbot:backToThread")}
              onClick={() => openTask(null)}
            />
            <BotFace bot={bot} size="pill" mood={task?.state === "working" ? "working" : "idle"} />
            <Text variant="label" truncate>
              {title}
            </Text>
          </>
        }
        trailing={
          <IconButton
            icon="close"
            kind="ghost"
            label={t("synbot:closeTask")}
            onClick={() => openTask(null)}
          />
        }
      />
      {task ? (
        <div className="task-bar__info">
          <Chip tone={taskTone(task.state)}>{t(taskStateKey(task.state))}</Chip>
          <span className="task-bar__meta">{formatRelativeTimeAgo(task.createdAt)}</span>
          {pr ? (
            <a className="task-bar__pr" href={pr} target="_blank" rel="noreferrer">
              {t("synbot:pullRequest")}
            </a>
          ) : null}
        </div>
      ) : null}
      {showProof ? (
        <div className="task-pane__proof">
          <ProofCard threadId={threadId} />
        </div>
      ) : null}
      <div className="task-pane__chat">
        <DeferredChatView
          key={threadId}
          threadId={threadId}
          hideHeader
          paneScopeId={`synbot-task:${threadId}`}
          deferMount={false}
          surfaceMode="split"
          isFocusedPane={false}
          panelState={EMBEDDED_PANEL_STATE}
          onToggleDiff={noopChatSurfaceAction}
          onToggleBrowser={noopChatSurfaceAction}
          onOpenBrowserUrl={noopChatSurfaceAction}
          onOpenTurnDiff={noopChatSurfaceAction}
        />
      </div>
    </Pane>
  );
}
