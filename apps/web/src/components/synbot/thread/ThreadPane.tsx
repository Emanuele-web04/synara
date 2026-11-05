// FILE: ThreadPane.tsx
// Purpose: A bot's thread on the SynBot page (HoloBot's thread/ThreadPane.tsx and TopBar.tsx):
//          the rows scroll under a floating top strip (the name pill with the bot's face, name
//          and engine, which opens its sheet; More with the engine and model, Edit and Settings)
//          and Synara's own composer floats over their end: the pane is Synara's ChatView for the
//          bot's thread, with HoloBot's rows (MessageList) in its transcript's place. The strip
//          publishes its height (--thread-top) and the composer's comes from ChatView, so the
//          list keeps its first and last rows clear of them and fades only where it runs under
//          them; a banner says when the bot's chat has an error.
// Layer: SynBot thread UI
// Exports: ThreadPane

import type { Bot, ModelSelection } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import type { SplitViewPanePanelState } from "~/splitViewStore";
import { useStore } from "~/store";
import { useSynbotStore } from "~/synbot/synbotStore";

import { DeferredChatView, noopChatSurfaceAction } from "../../chat/ChatThreadSurfacePrimitives";
import type { ChatTranscriptSlotInput } from "../../chat/chatTranscriptSlot";
import { toastManager } from "../../ui/toast";
import { BotFace, botMood } from "../BotFace";
import { useBotEditor } from "../editor/botEditorStore";
import { IconButton, Strip } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { Menu, type MenuEntry } from "../kit/Menu";
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
            description: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    [bot.id, bot.revision, t],
  );
}

function TopBar({ bot, answering }: { readonly bot: Bot; readonly answering: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openEdit = useBotEditor((store) => store.openEdit);
  const engine = useEngineMenu({ selection: bot.modelSelection, onChange: useSaveEngine(bot) });
  const more: MenuEntry[] = [
    ...engine.items,
    { rule: true },
    { id: "edit", label: t("synbot:editBotItem"), onSelect: () => openEdit(bot.id) },
    {
      id: "settings",
      label: t("synbot:settings"),
      onSelect: () => void navigate({ to: "/settings", search: { section: "synbot" } }),
    },
  ];
  return (
    <Strip
      center={
        <button
          type="button"
          className="thread-pill"
          title={t("synbot:editBot", { name: bot.name })}
          onClick={() => openEdit(bot.id)}
        >
          <BotFace bot={bot} size="pill" mood={answering ? "working" : botMood(bot.status)} />
          <span className="thread-pill__name">{bot.name}</span>
          <span className="thread-pill__engine">{engine.modelName}</span>
        </button>
      }
      trailing={
        <Menu
          label={t("synbot:more")}
          items={more}
          onOpenChange={engine.setOpen}
          trigger={<IconButton icon="more" kind="ghost" label={t("synbot:more")} />}
        />
      }
    />
  );
}

function Banner({ text }: { readonly text: string }) {
  return (
    <div className="banner" role="status" title={text}>
      <Icon name="loading" size="sm" />
      <span className="banner__text">{text}</span>
    </div>
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
  const error = useStore((state) => state.threadShellById?.[bot.threadId]?.error ?? null);
  // ChatView draws the composer (Synara's own) and hands its transcript's place to the rows.
  const renderTranscript = useCallback(
    (slot: ChatTranscriptSlotInput) => <MessageList bot={bot} slot={slot} onEdges={setEdges} />,
    [bot],
  );
  return (
    <section
      ref={pane}
      className="hb-pane hb-pane--fill thread-pane"
      data-under-top={edges.top || undefined}
      data-under-bottom={edges.bottom || undefined}
    >
      <div className="thread-pane__top" ref={top}>
        <TopBar bot={bot} answering={answering} />
        {error ? <Banner text={error} /> : null}
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
          onOpenBrowserUrl={noopChatSurfaceAction}
          onOpenTurnDiff={noopChatSurfaceAction}
          renderTranscript={renderTranscript}
          composerPlaceholder={t("synbot:placeholder", { name: bot.name })}
        />
      </div>
    </section>
  );
}
