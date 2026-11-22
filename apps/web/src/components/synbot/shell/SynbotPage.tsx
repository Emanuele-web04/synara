// FILE: SynbotPage.tsx
// Purpose: The SynBot page (HoloBot's shell/Shell.tsx inside Synara's frame): the selected bot's
//          thread (`?bot=`, SynBot without it) and, when a task is open (`?task=`), its own
//          thread in the right pane; when the window is too narrow for both, the task pane lies
//          over the thread's right edge. The bot sheet opens over it (`?new=bot`: New bot at its
//          Bot step, then the parameter is dropped). Synara's app rail and
//          sidebar panel (SynbotSidebar) stay around it.
// Layer: SynBot UI (route component for /synbot)
// Exports: default SynbotPage

import { BOT_MASCOT_COLORS, ThreadId } from "@synara/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAccount } from "~/hooks/useAccount";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import { altoGrantRetry, botById, orderedBots } from "~/synbot/synbotState.logic";
import {
  ensureSynbotMain,
  restartSynbotLiveSync,
  startSynbotLiveSync,
  useSynbotStore,
} from "~/synbot/synbotStore";

import { useAccountDialogStore } from "../../account/accountDialogStore";
import { CHAT_CONTENT_CARD_CLASS_NAME } from "../../chat/composerPickerStyles";
import { useOpenSynaraPlan, useSynaraPlan } from "../../settings/BillingSettingsPanel";
import { Badge } from "../../ui/badge";
import { BotSheetHost } from "../editor/BotSheet";
import { useBotEditor } from "../editor/botEditorStore";
import { CapsuleButton } from "../kit/controls";
import { BotMascot } from "../kit/Mascot";
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

function SynbotAltoGate() {
  const { t } = useTranslation();
  const { status: accountStatus } = useAccount();
  const openPlans = useOpenSynaraPlan();
  const signedOut = accountStatus?.state !== "signed-in";
  return (
    <div className="synbot-shell__state">
      <div className="synbot-shell__alto">
        <BotMascot shape="synara" color={BOT_MASCOT_COLORS[0]} size={48} mood="idle" />
        <div className="synbot-shell__alto-title">
          <h2 className="text-ui-lg font-medium text-foreground">{t("synbot:altoTitle")}</h2>
          <Badge variant="secondary" size="sm">
            {t("synbot:betaBadge")}
          </Badge>
        </div>
        <p className="synbot-shell__alto-body">{t("synbot:altoDescription")}</p>
        <div className="synbot-shell__alto-actions">
          {signedOut ? (
            <CapsuleButton
              kind="primary"
              onClick={() => useAccountDialogStore.getState().openSignIn()}
            >
              {t("synbot:altoSignIn")}
            </CapsuleButton>
          ) : null}
          <CapsuleButton kind={signedOut ? "normal" : "primary"} onClick={openPlans}>
            {t("synbot:altoViewPlans")}
          </CapsuleButton>
        </div>
      </div>
    </div>
  );
}

export default function SynbotPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: "/_chat/synbot" });
  const status = useSynbotStore((store) => store.status);
  const error = useSynbotStore((store) => store.error);
  const data = useSynbotStore((store) => store.data);
  const plan = useSynaraPlan();
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root);

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

  const bot = botById(data, search.bot) ?? orderedBots(data.bots).main;
  const taskThreadId = search.task ? ThreadId.makeUnsafe(search.task) : null;
  const task = taskThreadId
    ? (data.tasks.find((entry) => entry.task.workerThreadId === taskThreadId) ?? null)
    : null;

  let content;
  if (status === "subscription_required") {
    content = <SynbotAltoGate />;
  } else if (status === "unavailable") {
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
    <div
      ref={root}
      // Synara's route card: in the rail layout the page sits in the inset block under the
      // shell band, like every other route, its top strip on the band.
      className={cn("hb synbot-shell", CHAT_CONTENT_CARD_CLASS_NAME)}
      data-narrow={(narrow && taskThreadId) || undefined}
    >
      {content}
      <BotSheetHost />
    </div>
  );
}
