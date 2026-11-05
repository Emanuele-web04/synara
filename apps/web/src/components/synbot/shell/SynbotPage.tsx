// FILE: SynbotPage.tsx
// Purpose: The SynBot page (HoloBot's shell/Shell.tsx inside Synara's frame): the selected bot's
//          thread (`?bot=`, SynBot without it) and, when a task is open (`?task=`), its own
//          thread in the right pane; when the window is too narrow for both, the task pane lies
//          over the thread's right edge. The bot sheet opens over it. Synara's app rail and
//          sidebar panel (SynbotSidebar) stay around it.
// Layer: SynBot UI (route component for /synbot)
// Exports: default SynbotPage

import { ThreadId } from "@synara/contracts";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useTranslation } from "~/i18n";
import { botById, orderedBots } from "~/synbot/synbotState.logic";
import { ensureSynbotMain, startSynbotLiveSync, useSynbotStore } from "~/synbot/synbotStore";

import { BotSheetHost } from "../editor/BotSheet";
import { TaskPane } from "../thread/TaskPane";
import { ThreadPane } from "../thread/ThreadPane";
import "../kit/holobot.css";
import "./shell.css";

/** Narrower than the thread's least width plus the task pane: the pane lies over the thread. */
function useNarrow(root: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const least =
      (parseFloat(style.getPropertyValue("--hb-sessions")) || 380) +
      (parseFloat(style.getPropertyValue("--hb-thread-min")) || 440);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < least);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
  return narrow;
}

export default function SynbotPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: "/_chat/synbot" });
  const status = useSynbotStore((store) => store.status);
  const error = useSynbotStore((store) => store.error);
  const data = useSynbotStore((store) => store.data);
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root);

  useEffect(() => {
    startSynbotLiveSync();
    void ensureSynbotMain();
  }, []);

  const bot = botById(data, search.bot) ?? orderedBots(data.bots).main;
  const taskThreadId = search.task ? ThreadId.makeUnsafe(search.task) : null;
  const task = taskThreadId
    ? (data.tasks.find((entry) => entry.task.workerThreadId === taskThreadId) ?? null)
    : null;

  let content;
  if (status === "unavailable") {
    content = <p className="synbot-shell__state">{t("synbot:unavailable")}</p>;
  } else if (status === "error" && !bot) {
    content = <p className="synbot-shell__state">{error ?? t("synbot:loadFailed")}</p>;
  } else if (!bot) {
    content = <p className="synbot-shell__state">{t("synbot:loading")}</p>;
  } else {
    content = (
      <>
        <ThreadPane key={bot.id} bot={bot} />
        {taskThreadId ? (
          <TaskPane
            key={taskThreadId}
            threadId={taskThreadId}
            task={task?.task ?? null}
            bot={botById(data, task?.botId) ?? bot}
            showProof={data.settings.mergeProofEnabled}
          />
        ) : null}
      </>
    );
  }

  return (
    <div ref={root} className="hb synbot-shell" data-narrow={(narrow && taskThreadId) || undefined}>
      {content}
      <BotSheetHost />
    </div>
  );
}
