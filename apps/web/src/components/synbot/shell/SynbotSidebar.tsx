// FILE: SynbotSidebar.tsx
// Purpose: HoloBot's sidebar in Synara's sidebar panel on the SynBot page (shell/Sidebar.tsx,
//          PinnedTiles.tsx, ConversationRow.tsx and SidebarFoot.tsx): SynBot with its star and
//          the pinned bots as tiles three to a row (an amber dot while one waits on the user, a
//          blue one while it works); "My bots", a row per other bot with its face, name, time
//          and a status line (its last word, "Waiting on you", or its work); a right-click opens
//          Synara's context menu (native on desktop): Open, Edit, Pin or Unpin, Stop while it
//          works, Remove; the foot has New bot and Stop all.
// Layer: SynBot UI (rendered by Sidebar while the SynBot route is active)
// Exports: SynbotSidebar

import type { Bot, ContextMenuItem } from "@synara/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { useAppSettings } from "~/appSettings";
import { useNowMs } from "~/hooks/useNowMs";
import { getFormatLocale, useTranslation } from "~/i18n";
import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { latestBotPreview, listTime } from "~/synbot/botPreview.logic";
import { confirmAndRemoveBot, setBotPinned, stopBots } from "~/synbot/synbotActions";
import { orderedBots, tasksForBot } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";

import { SidebarPanelTitle } from "../../SidebarPanelTitle";
import { BotFace, botMood } from "../BotFace";
import { useBotEditor } from "../editor/botEditorStore";
import { AlertDialog } from "../kit/Dialog";
import { CapsuleButton, Dot, type DotTone } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenBot } from "../synbotNav";
import { useBotStatusLine } from "../useBotStatusLine";
import "./shell.css";

/** Short times are read again this often. */
const TIME_CHECK_MS = 60_000;

type BotMenuAction = "open" | "edit" | "toggle-pin" | "stop" | "remove";

/** A right-click on a bot (row or tile): Synara's context menu, native on desktop. */
function useBotContextMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openBot = useOpenBot();
  const openEdit = useBotEditor((store) => store.openEdit);
  const search = useSearch({ strict: false }) as { readonly bot?: string };
  return (bot: Bot, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readNativeApi();
    if (!api) return;
    const main = bot.kind === "main";
    const items: ContextMenuItem<BotMenuAction>[] = [
      { id: "open", label: t("synbot:open") },
      { id: "edit", label: t("synbotEditor:edit"), icon: THREAD_CONTEXT_MENU_ICONS.rename },
      ...(main
        ? []
        : [
            {
              id: "toggle-pin" as const,
              label: bot.pinned ? t("synbot:unpin") : t("synbot:pin"),
              icon: THREAD_CONTEXT_MENU_ICONS.pin,
            },
          ]),
      ...(bot.status === "working" || bot.status === "waiting"
        ? [{ id: "stop" as const, label: t("synbot:stop") }]
        : []),
      ...(main
        ? []
        : [
            {
              id: "remove" as const,
              label: t("synbotEditor:remove"),
              icon: THREAD_CONTEXT_MENU_ICONS.delete,
              destructive: true,
              separatorBefore: true,
            },
          ]),
    ];
    void (async () => {
      const clicked = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (clicked) {
        case "open":
          openBot(bot);
          return;
        case "edit":
          openEdit(bot.id);
          return;
        case "toggle-pin":
          await setBotPinned(bot, !bot.pinned);
          return;
        case "stop":
          await stopBots(bot);
          return;
        case "remove":
          // Its chat was open: SynBot's takes its place.
          if ((await confirmAndRemoveBot(bot)) && search.bot === bot.id) {
            void navigate({ to: "/synbot", search: {} });
          }
          return;
        default:
          return;
      }
    })();
  };
}

function Tile({
  bot,
  selected,
  onContextMenu,
}: {
  readonly bot: Bot;
  readonly selected: boolean;
  readonly onContextMenu?: (event: MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  const waiting = bot.status === "waiting";
  const busy = bot.status === "working";
  const state = waiting
    ? t("synbot:status_waiting")
    : busy
      ? t("synbot:isWorking", { name: bot.name })
      : undefined;
  return (
    <button
      type="button"
      className={`tile${selected ? " tile--selected" : ""}`}
      aria-pressed={selected}
      aria-label={state ? `${bot.name}, ${state}` : bot.name}
      title={state}
      onClick={() => openBot(bot)}
      onContextMenu={onContextMenu}
    >
      <span className="tile__mascot">
        <BotFace bot={bot} size="tile" mood={botMood(bot.status)} />
        {bot.kind === "main" ? (
          <span className="tile__star" aria-hidden>
            <Icon name="star" size="xs" />
          </span>
        ) : null}
      </span>
      <span className="tile__name">
        <span className="tile__label">{bot.name}</span>
        {waiting || busy ? <Dot tone={waiting ? "attention" : "active"} small /> : null}
      </span>
    </button>
  );
}

function ConversationRow({
  face,
  title,
  time,
  status,
  tone,
  selected,
  onSelect,
  onContextMenu,
}: {
  readonly face: ReactNode;
  readonly title: string;
  readonly time: string | null;
  readonly status: string;
  readonly tone: DotTone;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onContextMenu?: (event: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className={`conversation${selected ? " conversation--selected" : ""}`}
      aria-current={selected || undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      {face}
      <span className="conversation__text">
        <span className="conversation__top">
          <span className="conversation__title">{title}</span>
          {time ? <span className="conversation__time">{time}</span> : null}
        </span>
        <span className={`conversation__status conversation__status--${tone}`}>
          <Dot tone={tone} small />
          <span className="conversation__preview">{status}</span>
        </span>
      </span>
    </button>
  );
}

const BotRow = memo(function BotRow({
  bot,
  selected,
  now,
}: {
  readonly bot: Bot;
  readonly selected: boolean;
  readonly now: number;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const openBot = useOpenBot();
  const statusLine = useBotStatusLine();
  const data = useSynbotStore((store) => store.data);
  const tasks = useMemo(() => tasksForBot(data, bot.id), [bot.id, data]);
  const previewText = useStore((state) => latestBotPreview(state, bot.threadId)?.text ?? null);
  const previewAt = useStore(
    (state) =>
      latestBotPreview(state, bot.threadId)?.at ??
      state.threadShellById?.[bot.threadId]?.updatedAt ??
      null,
  );
  const showMenu = useBotContextMenu();
  const waiting = bot.status === "waiting";
  const busy = bot.status === "working";
  const line = waiting || busy || !previewText ? statusLine(bot, tasks) : previewText;
  const status = waiting
    ? previewText
      ? t("synbot:waitingOnYouLine", { line: previewText })
      : t("synbot:status_waiting")
    : line;
  const time = previewAt
    ? listTime(
        previewAt,
        now,
        getFormatLocale(),
        settings.timestampFormat === "locale" ? undefined : settings.timestampFormat === "12-hour",
      )
    : null;
  return (
    <ConversationRow
      face={<BotFace bot={bot} size="row" mood={botMood(bot.status)} />}
      title={bot.name}
      time={time}
      status={status}
      tone={waiting ? "attention" : busy ? "active" : "muted"}
      selected={selected}
      onSelect={() => openBot(bot)}
      onContextMenu={(event) => showMenu(bot, event)}
    />
  );
});

/** The panel sits in Synara's scrolling sidebar: it is at least as tall as the scroll's view,
 * so the foot rests at the bottom as HoloBot's does. */
function useFillScrollView() {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    let view = el?.parentElement ?? null;
    while (view && !/(auto|scroll)/.test(getComputedStyle(view).overflowY)) {
      view = view.parentElement;
    }
    if (!el || !view) return;
    const scroller = view;
    const fit = () => {
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      el.style.minHeight = `${Math.max(0, scroller.clientHeight - top - scroller.scrollTop)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  return root;
}

export function SynbotSidebar() {
  const { t } = useTranslation();
  const root = useFillScrollView();
  const search = useSearch({ strict: false }) as { readonly bot?: string };
  const status = useSynbotStore((store) => store.status);
  const bots = useSynbotStore((store) => store.data.bots);
  const openCreate = useBotEditor((store) => store.openCreate);
  const now = useNowMs(true, TIME_CHECK_MS);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const { main, pinned, others } = orderedBots(bots);
  const activeBotId = search.bot ?? main?.id ?? null;
  const tiles = main ? [main, ...pinned] : pinned;

  const showMenu = useBotContextMenu();

  const stopAll = () => {
    setStopping(true);
    void stopBots().finally(() => {
      setStopping(false);
      setConfirmStop(false);
    });
  };

  return (
    <div ref={root} className="hb synbot-sidebar">
      <SidebarPanelTitle title={t("synbot:pageTitle")} />
      {status === "unavailable" ? (
        <p className="conversations__none">{t("synbot:unavailable")}</p>
      ) : status !== "ready" && bots.length === 0 ? (
        <p className="conversations__none">{t("synbot:loading")}</p>
      ) : (
        <>
          {tiles.length > 0 ? (
            <div className="tiles" role="group" aria-label={t("synbot:pinned")}>
              {tiles.map((bot) => (
                <Tile
                  key={bot.id}
                  bot={bot}
                  selected={activeBotId === bot.id}
                  onContextMenu={(event) => showMenu(bot, event)}
                />
              ))}
            </div>
          ) : null}
          <div className="sidebar__scroll">
            <nav className="conversations" aria-label={t("synbot:myBots")}>
              <h2 className="sidebar__section">{t("synbot:myBots")}</h2>
              {others.length > 0 ? (
                others.map((bot) => (
                  <BotRow key={bot.id} bot={bot} selected={activeBotId === bot.id} now={now} />
                ))
              ) : (
                <div className="conversations__none">
                  <span>{t("synbot:noBotsYet")}</span>
                  <CapsuleButton
                    kind="normal"
                    small
                    onClick={() => openCreate({ template: "crew" })}
                  >
                    {t("synbot:createCrew")}
                  </CapsuleButton>
                </div>
              )}
            </nav>
          </div>
          <footer className="sidebar__foot">
            <CapsuleButton kind="normal" compact onClick={() => openCreate()}>
              <Icon name="plus" size="sm" />
              {t("synbot:newBot")}
            </CapsuleButton>
            <span className="sidebar__foot-spacer" />
            {bots.length > 0 ? (
              <CapsuleButton kind="ghost" compact onClick={() => setConfirmStop(true)}>
                <Icon name="stop" size="sm" />
                {t("synbot:stopAll")}
              </CapsuleButton>
            ) : null}
          </footer>
        </>
      )}
      <AlertDialog
        open={confirmStop}
        title={t("synbot:stopAllTitle")}
        message={t("synbot:stopAllDescription")}
        confirmLabel={t("synbot:stopAll")}
        danger
        busy={stopping}
        onConfirm={stopAll}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  );
}
