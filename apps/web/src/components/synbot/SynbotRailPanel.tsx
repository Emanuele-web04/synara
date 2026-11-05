// FILE: SynbotRailPanel.tsx
// Purpose: The rail panel on the SynBot page (HoloBot's bot sidebar): SynBot first, pinned bots
//          as tiles three to a row, then "My bots" rows with a status line and dot (amber waiting,
//          blue working). New bot opens the editor; Stop all stops every bot's work.
// Layer: SynBot UI (rendered by ThreadSidebar while the SynBot route is active)

import type { Bot } from "@synara/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import { AddPlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { AutomationListRow } from "~/routes/-automations.list";
import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "~/sidebarRowStyles";
import { orderedBots, tasksForBot } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";

import { SidebarPanelTitle } from "../SidebarPanelTitle";
import { SidebarPrimaryAction } from "../SidebarPrimaryAction";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SidebarGroup, SidebarMenu } from "../ui/sidebar";
import { StatusDot } from "../ui/status-chip";
import { toastManager } from "../ui/toast";
import { BotMascot, botMascotMood } from "./BotMascot";
import { useBotEditor } from "./editor/botEditorStore";
import { useBotStatusLine } from "./useBotStatusLine";
import { readNativeApi } from "~/nativeApi";

/** The dot a bot row or tile shows: amber waits on you, blue works, nothing when idle. */
export function BotStatusDot({
  bot,
  className,
}: {
  readonly bot: Bot;
  readonly className?: string;
}) {
  if (bot.status === "waiting") {
    return <StatusDot aria-hidden className={cn("bg-amber-500", className)} />;
  }
  if (bot.status === "working") {
    return <StatusDot aria-hidden pulse className={cn("bg-sky-500", className)} />;
  }
  return null;
}

function BotTile({
  bot,
  active,
  onSelect,
}: {
  readonly bot: Bot;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-ui-xs text-foreground/80 transition-colors hover:bg-accent/60",
        active && "bg-accent text-foreground",
      )}
    >
      <BotMascot mascot={bot.mascot} size="tile" mood={botMascotMood(bot.status)} seed={bot.id} />
      <span className="w-full truncate text-center">{bot.name}</span>
      <BotStatusDot bot={bot} className="absolute top-2 right-3" />
    </button>
  );
}

export function SynbotRailPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { readonly bot?: string };
  const status = useSynbotStore((store) => store.status);
  const data = useSynbotStore((store) => store.data);
  const openCreate = useBotEditor((store) => store.openCreate);
  const statusLine = useBotStatusLine();
  const [confirmStop, setConfirmStop] = useState(false);
  const { main, pinned, others } = orderedBots(data.bots);
  const activeBotId = search.bot ?? main?.id ?? null;
  const select = (bot: Bot) =>
    void navigate({ to: "/synbot", search: bot.kind === "main" ? {} : { bot: bot.id } });

  const stopAll = () => {
    setConfirmStop(false);
    void readNativeApi()
      ?.bots.stopAll()
      .then((result) =>
        toastManager.add({
          type: "success",
          title: t("synbot:stopAllDone", {
            count: result.interruptedThreadIds.length + result.cancelledTaskIds.length,
          }),
        }),
      )
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:stopAllFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      );
  };

  const renderRow = (bot: Bot) => (
    <AutomationListRow
      key={bot.id}
      density="panel"
      active={activeBotId === bot.id}
      dimmed={bot.status === "paused"}
      onClick={() => select(bot)}
      leading={
        <BotMascot
          mascot={bot.mascot}
          size="inline"
          mood={botMascotMood(bot.status)}
          seed={bot.id}
        />
      }
      title={bot.name}
      detail={statusLine(bot, tasksForBot(data, bot.id))}
      meta={<BotStatusDot bot={bot} />}
    />
  );

  return (
    <>
      <SidebarPanelTitle title={t("synbot:pageTitle")} />
      <SidebarGroup className="px-1.5 pt-1 pb-1.5">
        <SidebarMenu className="gap-0.5">
          <SidebarPrimaryAction
            icon={AddPlusIcon}
            label={t("synbot:newBot")}
            onClick={() => openCreate()}
          />
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="gap-2 px-1.5 py-1.5">
        {status === "unavailable" ? (
          <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
            {t("synbot:unavailable")}
          </div>
        ) : status !== "ready" && data.bots.length === 0 ? (
          <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
            {t("synbot:loading")}
          </div>
        ) : (
          <>
            {main ? <div className="flex flex-col gap-0.5">{renderRow(main)}</div> : null}
            {pinned.length > 0 ? (
              <div className="grid grid-cols-3 gap-1">
                {pinned.map((bot) => (
                  <BotTile
                    key={bot.id}
                    bot={bot}
                    active={activeBotId === bot.id}
                    onSelect={() => select(bot)}
                  />
                ))}
              </div>
            ) : null}
            <section className="flex flex-col">
              <div className={cn("flex h-7 items-center px-2", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>
                {t("synbot:myBots")}
              </div>
              {others.length > 0 ? (
                <div className="flex flex-col gap-0.5">{others.map(renderRow)}</div>
              ) : (
                <div className="flex flex-col items-start gap-1 px-2 py-1 text-ui-sm text-muted-foreground">
                  <span>{t("synbot:noBotsYet")}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => openCreate({ template: "crew" })}
                  >
                    {t("synbot:createCrew")}
                  </Button>
                </div>
              )}
            </section>
            {data.bots.length > 0 ? (
              <div className="px-2 pt-2">
                <Button size="xs" variant="ghost" onClick={() => setConfirmStop(true)}>
                  {t("synbot:stopAll")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </SidebarGroup>
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("synbot:stopAllTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("synbot:stopAllDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t("common:form_cancel")}
            </AlertDialogClose>
            <Button variant="destructive" size="sm" onClick={stopAll}>
              {t("synbot:stopAll")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
