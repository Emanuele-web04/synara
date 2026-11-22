// FILE: SynbotSidebar.tsx
// Purpose: HoloBot's sidebar in Synara's sidebar panel on the SynBot page (shell/Sidebar.tsx,
//          PinnedTiles.tsx, ConversationRow.tsx and SidebarFoot.tsx): SynBot with its star and
//          the pinned bots as tiles three to a row (an amber dot while one waits for the user, a
//          blue one while it works); "My bots", a row per other bot with its face, name, time
//          and a status line (its last word, "Waiting for you", or its work). A bot's actions
//          (Open, Edit, Pin or Unpin, Stop while it works, Remove) open in Synara's context menu
//          (native on desktop) from a right-click, the keyboard's menu key or the row's "…"
//          button. The foot has New bot, and Stop all while there is something to stop. While
//          the bots load it shows placeholder rows; a failed load offers Retry.
// Layer: SynBot UI (rendered by Sidebar while the SynBot route is active)
// Exports: SynbotSidebar

import type { Bot, ContextMenuItem } from "@synara/contracts";
import { useSearch } from "@tanstack/react-router";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";

import { useAppSettings } from "~/appSettings";
import { useNowMs } from "~/hooks/useNowMs";
import { getFormatLocale, useTranslation } from "~/i18n";
import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";
import { EllipsisIcon } from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { latestBotPreview, listTime } from "~/synbot/botPreview.logic";
import { askToRemoveBot, askToStopAllBots, setBotPinned, stopBots } from "~/synbot/synbotActions";
import {
  orderedBots,
  selectedBot,
  synbotHasStoppableWork,
  tasksForBot,
} from "~/synbot/synbotState.logic";
import { ensureSynbotMain, restartSynbotLiveSync, useSynbotStore } from "~/synbot/synbotStore";

import { SidebarIconButton } from "../../SidebarIconButton";
import { SidebarPanelTitle } from "../../SidebarPanelTitle";
import { Badge } from "../../ui/badge";
import { Skeleton } from "../../ui/skeleton";
import { BotFace, botMood } from "../BotFace";
import { useBotEditor } from "../editor/botEditorStore";
import { CapsuleButton, Dot, type DotTone } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenBot } from "../synbotNav";
import { useBotStatusLine } from "../useBotStatusLine";
import "./shell.css";

/** Short times are read again this often. */
const TIME_CHECK_MS = 60_000;

/** Placeholder rows while the bots load. */
const SKELETON_ROWS = 3;

type BotMenuAction = "open" | "edit" | "toggle-pin" | "stop" | "remove";

/** Where a bot's menu opens: at the pointer, or under the control for the keyboard's menu key
 * (its event has no pointer position) and the "…" button. */
function menuPoint(event: MouseEvent<HTMLElement>, below: boolean): { x: number; y: number } {
  if (!below && (event.clientX !== 0 || event.clientY !== 0)) {
    return { x: event.clientX, y: event.clientY };
  }
  const rect = event.currentTarget.getBoundingClientRect();
  return below ? { x: rect.left, y: rect.bottom } : { x: rect.left, y: rect.top + rect.height / 2 };
}

/** A bot's actions in Synara's context menu (native on desktop). */
function useBotMenu() {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  const openEdit = useBotEditor((store) => store.openEdit);
  return useCallback(
    (bot: Bot, at: { x: number; y: number }) => {
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
        const clicked = await api.contextMenu.show(items, at);
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
            // The confirmation leaves its chat for SynBot's when it was open.
            askToRemoveBot(bot);
            return;
          default:
            return;
        }
      })();
    },
    [openBot, openEdit, t],
  );
}

/** The row's or tile's "…": the same actions as a right-click, for touch and the keyboard. */
function BotMoreButton({
  bot,
  className,
  onOpen,
}: {
  readonly bot: Bot;
  readonly className: string;
  readonly onOpen: (bot: Bot, at: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();
  return (
    <SidebarIconButton
      icon={EllipsisIcon}
      label={t("synbot:botActions", { name: bot.name })}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(bot, menuPoint(event, true));
      }}
    />
  );
}

function Tile({
  bot,
  selected,
  onMenu,
}: {
  readonly bot: Bot;
  readonly selected: boolean;
  readonly onMenu: (bot: Bot, at: { x: number; y: number }) => void;
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
    <div className={`tile${selected ? " tile--selected" : ""}`}>
      <button
        type="button"
        className="tile__main"
        aria-current={selected || undefined}
        aria-label={state ? `${bot.name}, ${state}` : bot.name}
        title={state}
        onClick={() => openBot(bot)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu(bot, menuPoint(event, false));
        }}
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
      <BotMoreButton bot={bot} className="tile__more" onOpen={onMenu} />
    </div>
  );
}

function ConversationRow({
  face,
  title,
  time,
  status,
  tone,
  selected,
  more,
  onSelect,
  onContextMenu,
}: {
  readonly face: ReactNode;
  readonly title: string;
  readonly time: string | null;
  readonly status: string;
  readonly tone: DotTone;
  readonly selected: boolean;
  readonly more: ReactNode;
  readonly onSelect: () => void;
  readonly onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className={`conversation${selected ? " conversation--selected" : ""}`}>
      <button
        type="button"
        className="conversation__main"
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
          {/* The last word alone (HoloBot's list); a dot on the right only when the bot is
              working or waiting for you. */}
          <span className={`conversation__status conversation__status--${tone}`}>
            <span className="conversation__preview">{status}</span>
            {tone === "attention" || tone === "active" ? <Dot tone={tone} small /> : null}
          </span>
        </span>
      </button>
      {more}
    </div>
  );
}

const BotRow = memo(function BotRow({
  bot,
  selected,
  now,
  onMenu,
}: {
  readonly bot: Bot;
  readonly selected: boolean;
  readonly now: number;
  readonly onMenu: (bot: Bot, at: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const openBot = useOpenBot();
  const statusLine = useBotStatusLine();
  const data = useSynbotStore((store) => store.data);
  const tasks = useMemo(() => tasksForBot(data, bot.id), [bot.id, data]);
  // A hand-off's preview prefers the live delegation's brief to the one read from its prompt.
  const briefOf = useCallback(
    (id: string) => data.delegations.find((delegation) => delegation.id === id)?.brief ?? null,
    [data.delegations],
  );
  const previewText = useStore(
    (state) => latestBotPreview(state, bot.threadId, briefOf)?.text ?? null,
  );
  const previewAt = useStore(
    (state) =>
      latestBotPreview(state, bot.threadId, briefOf)?.at ??
      state.threadShellById?.[bot.threadId]?.updatedAt ??
      null,
  );
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
      more={<BotMoreButton bot={bot} className="conversation__more" onOpen={onMenu} />}
      onSelect={() => openBot(bot)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(bot, menuPoint(event, false));
      }}
    />
  );
});

/** The rows' shape while the bots load. */
function SkeletonRows({ label }: { readonly label: string }) {
  return (
    <div className="conversations" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="conversation conversation--skeleton" aria-hidden>
          <Skeleton className="size-8 shrink-0 rounded-[22%]" />
          <span className="conversation__text">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2.5 w-36 max-w-full" />
          </span>
        </div>
      ))}
    </div>
  );
}

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

/** Reloads SynBot after a failed load. */
function retryLoad() {
  restartSynbotLiveSync();
  void ensureSynbotMain();
}

export function SynbotSidebar() {
  const { t } = useTranslation();
  const root = useFillScrollView();
  const search = useSearch({ strict: false }) as { readonly bot?: string };
  const status = useSynbotStore((store) => store.status);
  const data = useSynbotStore((store) => store.data);
  const openCreate = useBotEditor((store) => store.openCreate);
  const now = useNowMs(true, TIME_CHECK_MS);
  const showMenu = useBotMenu();
  const { main, pinned, others } = orderedBots(data.bots);
  // The page shows the same bot: a stale `?bot=` highlights SynBot, as the page opens it.
  const activeBotId = selectedBot(data, search.bot)?.id ?? null;
  const tiles = main ? [main, ...pinned] : pinned;
  const stoppable = synbotHasStoppableWork(data);

  let body: ReactNode;
  if (status === "subscription_required") {
    body = <p className="conversations__none">{t("synbot:altoSidebarNote")}</p>;
  } else if (status === "unavailable") {
    body = <p className="conversations__none">{t("synbot:unavailable")}</p>;
  } else if (status === "error" && data.bots.length === 0) {
    body = (
      <div className="conversations__none" role="alert">
        <span>{t("synbot:loadFailed")}</span>
        <CapsuleButton kind="normal" small onClick={retryLoad}>
          {t("common:common_retry")}
        </CapsuleButton>
      </div>
    );
  } else if (status !== "ready" && data.bots.length === 0) {
    body = <SkeletonRows label={t("synbot:loading")} />;
  } else {
    body = (
      <>
        {tiles.length > 0 ? (
          <div className="tiles" role="group" aria-label={t("synbot:pinned")}>
            {tiles.map((bot) => (
              <Tile key={bot.id} bot={bot} selected={activeBotId === bot.id} onMenu={showMenu} />
            ))}
          </div>
        ) : null}
        <div className="sidebar__scroll">
          <nav className="conversations" aria-label={t("synbot:myBots")}>
            <h2 className="sidebar__section">{t("synbot:myBots")}</h2>
            {others.length > 0 ? (
              others.map((bot) => (
                <BotRow
                  key={bot.id}
                  bot={bot}
                  selected={activeBotId === bot.id}
                  now={now}
                  onMenu={showMenu}
                />
              ))
            ) : (
              <div className="conversations__none">
                <span>{t("synbot:noBotsYet")}</span>
                <CapsuleButton kind="normal" small onClick={() => openCreate({ template: "crew" })}>
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
          {stoppable ? (
            <CapsuleButton kind="ghost" compact onClick={askToStopAllBots}>
              <Icon name="stop" size="sm" />
              {t("synbot:stopAll")}
            </CapsuleButton>
          ) : null}
        </footer>
      </>
    );
  }

  return (
    <div ref={root} className="hb synbot-sidebar">
      <SidebarPanelTitle title={t("synbot:pageTitle")}>
        <Badge variant="secondary" size="sm">
          {t("synbot:betaBadge")}
        </Badge>
      </SidebarPanelTitle>
      {body}
    </div>
  );
}
