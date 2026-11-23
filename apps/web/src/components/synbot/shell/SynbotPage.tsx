// FILE: SynbotPage.tsx
// Purpose: The SynBot page (HoloBot's shell/Shell.tsx inside Synara's frame): the selected bot's
//          thread (`?bot=`; SynBot without it, or when it names a bot that is gone) and, when a
//          task is open (`?task=`), its own thread in the right pane. When the window is too
//          narrow for both, the task pane lies over the thread behind a scrim that closes it;
//          narrower than a phone's width it takes the whole page. The bot sheet opens over it
//          (`?new=bot`: New bot at its Bot step, then the parameter is dropped). Loading, a
//          failed load (with Retry) and a host without SynBot each have their own state.
//          Synara's app rail and sidebar panel (SynbotSidebar) stay around it.
// Layer: SynBot UI (route component for /synbot)
// Exports: default SynbotPage

import { ThreadId } from "@synara/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import { altoGrantRetry, botById, selectedBot } from "~/synbot/synbotState.logic";
import {
  ensureSynbotMain,
  restartSynbotLiveSync,
  startSynbotLiveSync,
  useSynbotStore,
} from "~/synbot/synbotStore";

import { CHAT_CONTENT_CARD_CLASS_NAME } from "../../chat/composerPickerStyles";
import { useSynaraPlan } from "../../settings/BillingSettingsPanel";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { Spinner } from "../../ui/spinner";
import { BotSheetHost } from "../editor/BotSheet";
import { useBotEditor } from "../editor/botEditorStore";
import { CapsuleButton } from "../kit/controls";
import { useOpenTask } from "../synbotNav";
import { TaskPane } from "../thread/TaskPane";
import { ThreadPane } from "../thread/ThreadPane";
import { SynbotAltoGate } from "./SynbotAltoGate";
import "../kit/holobot.css";
import "./shell.css";

/** Under this width the task pane covers the whole page instead of most of it. */
const FULL_TASK_PANE_WIDTH = 480;

/**
 * How the task pane sits: beside the thread (null), over its right edge ("over"), or over the
 * whole page ("full"), from the page's width and the panes' least widths.
 */
function useTaskPaneFit(root: React.RefObject<HTMLElement | null>): "over" | "full" | null {
  const [fit, setFit] = useState<"over" | "full" | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const least =
      (parseFloat(style.getPropertyValue("--hb-sessions")) || 380) +
      (parseFloat(style.getPropertyValue("--hb-thread-min")) || 440);
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = entry.contentRect.width;
      setFit(width < FULL_TASK_PANE_WIDTH ? "full" : width < least ? "over" : null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
  return fit;
}

/** Loading, a failed load and a host without SynBot: the app's empty state in the page. */
function PageState({
  title,
  description,
  busy,
  onRetry,
}: {
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly busy?: boolean;
  readonly onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Empty aria-busy={busy || undefined}>
      <EmptyHeader>
        {busy ? <Spinner className="mb-3 size-5 text-muted-foreground" /> : null}
        <EmptyTitle className="text-ui-lg font-medium">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent>
          <CapsuleButton kind="normal" onClick={onRetry}>
            {t("common:common_retry")}
          </CapsuleButton>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

/** Reloads SynBot after a failed load. */
function retryLoad() {
  restartSynbotLiveSync();
  void ensureSynbotMain();
}

export default function SynbotPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: "/_chat/synbot" });
  const status = useSynbotStore((store) => store.status);
  const error = useSynbotStore((store) => store.error);
  const data = useSynbotStore((store) => store.data);
  const plan = useSynaraPlan();
  const root = useRef<HTMLDivElement>(null);
  const fit = useTaskPaneFit(root);
  const openTask = useOpenTask();

  useEffect(() => {
    if (useSynbotStore.getState().status === "subscription_required") {
      restartSynbotLiveSync();
    } else {
      startSynbotLiveSync();
    }
    void ensureSynbotMain();
  }, []);
  // When a previously locked user subscribes to Alto, re-open the stream immediately, once:
  // a server that still refuses must not be retried in a loop.
  const retriedForGrant = useRef(false);
  useEffect(() => {
    const next = altoGrantRetry({
      granted: plan?.granted === true,
      subscriptionRequired: status === "subscription_required",
      retried: retriedForGrant.current,
    });
    retriedForGrant.current = next.retried;
    if (!next.retry) return;
    restartSynbotLiveSync();
    void ensureSynbotMain();
  }, [plan?.granted, status]);
  // Step one chose this computer on another computer's page: go on from the Bot step.
  const navigate = useNavigate();
  useEffect(() => {
    if (search.new !== "bot") return;
    if (status === "subscription_required") return;
    useBotEditor.getState().openCreate({ startAt: "bot" });
    void navigate({
      to: "/synbot",
      search: search.bot ? { bot: search.bot } : {},
      replace: true,
    });
  }, [navigate, search.bot, search.new, status]);

  // The sidebar highlights the same bot (selectedBot), stale links included.
  const bot = selectedBot(data, search.bot);
  const taskThreadId = search.task ? ThreadId.makeUnsafe(search.task) : null;
  const task = taskThreadId
    ? (data.tasks.find((entry) => entry.task.workerThreadId === taskThreadId) ?? null)
    : null;
  const taskOver = taskThreadId !== null && fit !== null;

  let content;
  if (status === "subscription_required") {
    content = (
      <div className="synbot-shell__state">
        <SynbotAltoGate />
      </div>
    );
  } else if (status === "unavailable") {
    content = <PageState title={t("synbot:unavailable")} />;
  } else if (status === "error" && !bot) {
    content = <PageState title={t("synbot:loadFailed")} description={error} onRetry={retryLoad} />;
  } else if (!bot) {
    content = <PageState title={t("synbot:loading")} busy />;
  } else {
    content = (
      <>
        <ThreadPane key={bot.id} bot={bot} />
        {taskThreadId ? (
          <>
            {taskOver ? (
              <button
                type="button"
                className="synbot-shell__scrim"
                aria-label={t("synbot:closeTask")}
                tabIndex={-1}
                onClick={() => openTask(null)}
              />
            ) : null}
            <TaskPane
              key={taskThreadId}
              threadId={taskThreadId}
              task={task?.task ?? null}
              bot={botById(data, task?.botId) ?? bot}
              showProof={data.settings.mergeProofEnabled}
            />
          </>
        ) : null}
      </>
    );
  }

  return (
    <div
      ref={root}
      // Synara's route card: in the rail layout the page sits in the inset block under the
      // shell band, like every other route, its top strip on the band.
      className={cn("hb synbot-shell", CHAT_CONTENT_CARD_CLASS_NAME)}
      data-narrow={taskOver ? fit : undefined}
    >
      {content}
      <BotSheetHost />
    </div>
  );
}
