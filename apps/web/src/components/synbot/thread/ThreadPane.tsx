// FILE: ThreadPane.tsx
// Purpose: A bot's thread on the SynBot page (HoloBot's thread/TopBar.tsx and ThreadPane.tsx):
//          the rows scroll under a floating top strip (on the left the name pill with the bot's
//          face and name, which opens its sheet; on the right the chat's permission, model and
//          context controls, which ChatView draws there instead of under the composer, then More
//          with Default model (the bot's engine for new chats and tasks, in a submenu), Edit and
//          Settings) and Synara's own composer floats over their end, its Send button in
//          HoloBot's metal ring: the pane is Synara's ChatView for the bot's thread, with
//          HoloBot's rows (MessageList) in its transcript's place. The strip publishes its
//          height (--thread-top) and the composer's comes from ChatView, so the list keeps its
//          first and last rows clear of them and fades only where it runs under them; the
//          thread's error banner (Synara's own, drawn by the rows) sits under the strip.
//          Diffs and browser links open in the thread's own view, thread links in the SynBot
//          page.
// Layer: SynBot thread UI
// Exports: ThreadPane

import type { Bot, ModelSelection } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { describeErrorMessage } from "@synara/shared/errorMessages";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import type { SplitViewPanePanelState } from "~/splitViewStore";
import { useSynbotStore } from "~/synbot/synbotStore";

import { DeferredChatView, noopChatSurfaceAction } from "../../chat/ChatThreadSurfacePrimitives";
import type { ChatTranscriptSlotInput } from "../../chat/chatTranscriptSlot";
import { toastManager } from "../../ui/toast";
import { BotFace, botMood } from "../BotFace";
import { useBotEditor } from "../editor/botEditorStore";
import { IconButton, SendRing, Strip } from "../kit/controls";
import { Backdrop } from "../kit/Backdrop";
import { Menu, type MenuEntry } from "../kit/Menu";
import { useEmbeddedChatPanels, useOpenThreadLink } from "./chatLinks";
import { MessageList } from "./MessageList";
import type { TranscriptEdges } from "./Transcript";
import { useBotAnswering } from "./useBotThread";
import { useEngineMenu } from "./useEngineMenu";
import "./thread.css";

/** The top strip's height, published on the pane: the list keeps its first row clear of it. */
function useBarHeights(pane: RefObject<HTMLElement | null>, top: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const [el, topEl] = [pane.current, top.current];
    if (!el || !topEl) return;
    const publish = () => el.style.setProperty("--thread-top", `${topEl.offsetHeight}px`);
    const observer = new ResizeObserver(publish);
    observer.observe(topEl);
    publish();
    return () => observer.disconnect();
  }, [pane, top]);
}

/** Saves the bot's chat engine (bots.update with the revision it has). */
function useSaveEngine(bot: Bot) {
  const { t } = useTranslation();
  return useCallback(
    (modelSelection: ModelSelection) => {
      const api = readNativeApi();
      if (!api) return;
      void api.bots
        .update({ id: bot.id, expectedRevision: bot.revision, modelSelection })
        .then((next) => useSynbotStore.getState().applyEvent({ type: "bot-upserted", bot: next }))
        .catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: t("synbot:engineFailed"),
            description: describeErrorMessage(error, String(error)),
          }),
        );
    },
    [bot.id, bot.revision, t],
  );
}

/** More: Default model (a submenu, so the engine list never buries the rest), Edit bot and
 * SynBot settings. */
function MoreMenu({ bot }: { readonly bot: Bot }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openEdit = useBotEditor((store) => store.openEdit);
  const engine = useEngineMenu({ selection: bot.modelSelection, onChange: useSaveEngine(bot) });
  const items: readonly MenuEntry[] = [
    {
      id: "engine",
      label: t("synbot:defaultModel"),
      detail: engine.label,
      hint: t("synbot:defaultModelHint"),
      submenu: engine.items,
    },
    { rule: true },
    { id: "edit", label: t("synbot:editBotItem"), onSelect: () => openEdit(bot.id) },
    {
      id: "settings",
      label: t("synbot:settings"),
      onSelect: () => void navigate({ to: "/settings", search: { section: "synbot" } }),
    },
  ];
  return (
    <Menu
      trigger={<IconButton icon="more" kind="ghost" label={t("synbot:more")} />}
      items={items}
      label={t("synbot:more")}
      onOpenChange={(open) => engine.setOpen(open)}
    />
  );
}

function TopBar({
  bot,
  answering,
  controlsRef,
}: {
  readonly bot: Bot;
  readonly answering: boolean;
  /** Where ChatView draws the chat's controls. */
  readonly controlsRef: (element: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  const openEdit = useBotEditor((store) => store.openEdit);
  return (
    <Strip
      className="thread-strip"
      leading={
        <button
          type="button"
          className="thread-pill"
          title={t("synbot:editBot", { name: bot.name })}
          onClick={() => openEdit(bot.id)}
        >
          <BotFace bot={bot} size="pill" mood={answering ? "working" : botMood(bot.status)} />
          <span className="thread-pill__name">{bot.name}</span>
        </button>
      }
      trailing={
        <>
          <div className="thread-controls" ref={controlsRef} />
          <MoreMenu bot={bot} />
        </>
      }
    />
  );
}

const EMBEDDED_PANEL_STATE: SplitViewPanePanelState = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "browser",
};

export function ThreadPane({ bot }: { readonly bot: Bot }) {
  const { t } = useTranslation();
  const pane = useRef<HTMLElement>(null);
  const top = useRef<HTMLDivElement>(null);
  useBarHeights(pane, top);
  const [edges, setEdges] = useState<TranscriptEdges>({ top: false, bottom: false });
  const answering = useBotAnswering(bot.threadId);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const [bannerTarget, setBannerTarget] = useState<HTMLDivElement | null>(null);
  const { openTurnDiff, openBrowserUrl } = useEmbeddedChatPanels(bot.threadId);
  const openThreadLink = useOpenThreadLink();
  // ChatView draws the composer (Synara's own) and hands its transcript's place to the rows.
  const renderTranscript = useCallback(
    (slot: ChatTranscriptSlotInput) => (
      <MessageList bot={bot} slot={slot} bannerTarget={bannerTarget} onEdges={setEdges} />
    ),
    [bannerTarget, bot],
  );
  return (
    <section
      ref={pane}
      className="hb-pane hb-pane--fill thread-pane"
      data-under-top={edges.top || undefined}
      data-under-bottom={edges.bottom || undefined}
    >
      <Backdrop />
      <div className="thread-pane__top" ref={top}>
        <TopBar bot={bot} answering={answering} controlsRef={setControls} />
        <div className="thread-pane__banner" ref={setBannerTarget} />
      </div>
      <div className="thread-pane__chat">
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
          onOpenBrowserUrl={openBrowserUrl}
          onOpenTurnDiff={openTurnDiff}
          onOpenLinkedThread={openThreadLink}
          renderTranscript={renderTranscript}
          composerPlaceholder={t("synbot:placeholder", { name: bot.name })}
          composerStatusTarget={controls}
          composerSendUnderlay={<SendRing moving={answering} />}
        />
      </div>
    </section>
  );
}
