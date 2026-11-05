// FILE: SynbotView.tsx
// Purpose: The SynBot page's main column (HoloBot's thread layout): a floating bot pill and
//          engine chip over the selected bot's chat, and a task opened on the right as its own
//          thread. The chat itself is Synara's ChatView (composer, streaming, scroll, approvals);
//          SynBot cards render inside its transcript (SynbotNoticeRow).
// Layer: SynBot UI (route component for /synbot)

import type { Bot, ThreadId } from "@synara/contracts";
import { useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import type { SplitViewPanePanelState } from "~/splitViewStore";
import { botById, orderedBots } from "~/synbot/synbotState.logic";
import { ensureSynbotMain, startSynbotLiveSync, useSynbotStore } from "~/synbot/synbotStore";

import { DeferredChatView, noopChatSurfaceAction } from "../chat/ChatThreadSurfacePrimitives";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import { Button } from "../ui/button";
import { BotMascot, botMascotMood } from "./BotMascot";
import { BotEditorHost } from "./editor/BotEditorSheet";
import { useBotEditor } from "./editor/botEditorStore";
import { SynbotMergeProofCard } from "./SynbotMergeProofCard";
import { BotStatusDot } from "./SynbotRailPanel";
import { useBotStatusLine } from "./useBotStatusLine";
import { XIcon } from "~/lib/icons";

const EMBEDDED_PANEL_STATE: SplitViewPanePanelState = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "browser",
};

function BotPill({ bot }: { readonly bot: Bot }) {
  const { t } = useTranslation();
  const openEdit = useBotEditor((store) => store.openEdit);
  const statusLine = useBotStatusLine();
  const tasks = useSynbotStore((store) => store.data.tasks);
  const botTasks = tasks.filter((entry) => entry.botId === bot.id).map((entry) => entry.task);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background/90 py-1 pr-1 pl-1.5 shadow-sm backdrop-blur">
        <button
          type="button"
          onClick={() => openEdit(bot.id)}
          className="flex min-w-0 items-center gap-2 rounded-full px-1.5 py-0.5 hover:bg-accent/60"
          aria-label={t("synbot:editBot", { name: bot.name })}
        >
          <BotMascot
            mascot={bot.mascot}
            size="pill"
            mood={botMascotMood(bot.status)}
            seed={bot.id}
          />
          <span className="truncate text-ui font-medium text-foreground">{bot.name}</span>
          <span className="hidden truncate text-ui-sm text-muted-foreground sm:inline">
            {statusLine(bot, botTasks)}
          </span>
          <BotStatusDot bot={bot} />
        </button>
        <button
          type="button"
          onClick={() => openEdit(bot.id)}
          className="shrink-0 rounded-full bg-accent/70 px-2 py-0.5 text-ui-xs text-foreground/80 hover:bg-accent"
          aria-label={t("synbot:changeEngine")}
        >
          {bot.modelSelection.model}
        </button>
      </div>
    </div>
  );
}

function TaskPane({
  threadId,
  title,
  showProof,
  onClose,
}: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly showProof: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="flex h-full w-[min(44rem,46%)] min-w-[22rem] shrink-0 flex-col border-l border-border/60 bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{title}</span>
        <Button size="icon-sm" variant="ghost" aria-label={t("synbot:closeTask")} onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {showProof ? (
        <div className="shrink-0 px-3 pb-2">
          <SynbotMergeProofCard threadId={threadId} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
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
    </aside>
  );
}

export default function SynbotView() {
  const { t } = useTranslation();
  const search = useSearch({ from: "/_chat/synbot" });
  const status = useSynbotStore((store) => store.status);
  const error = useSynbotStore((store) => store.error);
  const data = useSynbotStore((store) => store.data);
  const [taskThreadId, setTaskThreadId] = useState<ThreadId | null>(null);

  useEffect(() => {
    startSynbotLiveSync();
    void ensureSynbotMain();
  }, []);

  const bot = botById(data, search.bot) ?? orderedBots(data.bots).main;
  // A different bot closes the task opened from the previous one.
  useEffect(() => setTaskThreadId(null), [bot?.id]);

  const openTask = useCallback((threadId: ThreadId) => setTaskThreadId(threadId), []);
  const task = taskThreadId
    ? (data.tasks.find((entry) => entry.task.workerThreadId === taskThreadId)?.task ?? null)
    : null;

  let content;
  if (status === "unavailable") {
    content = <PanelStateMessage>{t("synbot:unavailable")}</PanelStateMessage>;
  } else if (status === "error" && !bot) {
    content = <PanelStateMessage>{error ?? t("synbot:loadFailed")}</PanelStateMessage>;
  } else if (!bot) {
    content = <PanelStateMessage>{t("synbot:loading")}</PanelStateMessage>;
  } else {
    content = (
      <div className="flex h-full min-h-0">
        <div className={cn("relative flex min-w-0 flex-1 flex-col")}>
          <BotPill bot={bot} />
          <DeferredChatView
            key={bot.threadId}
            threadId={bot.threadId}
            hideHeader
            paneScopeId={`synbot:${bot.id}`}
            deferMount={false}
            surfaceMode="single"
            isFocusedPane
            panelState={EMBEDDED_PANEL_STATE}
            onToggleDiff={noopChatSurfaceAction}
            onToggleBrowser={noopChatSurfaceAction}
            onOpenBrowserUrl={noopChatSurfaceAction}
            onOpenTurnDiff={noopChatSurfaceAction}
            onOpenLinkedThread={openTask}
          />
        </div>
        {taskThreadId ? (
          <TaskPane
            threadId={taskThreadId}
            title={task?.title ?? t("synbot:task")}
            showProof={data.settings.mergeProofEnabled}
            onClose={() => setTaskThreadId(null)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      {content}
      <BotEditorHost />
    </>
  );
}
