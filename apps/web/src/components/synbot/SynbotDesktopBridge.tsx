// FILE: SynbotDesktopBridge.tsx
// Purpose: SynBot's ties to the window and the desktop app (Beta): the app menu's SynBot items
//          (Open SynBot, New Bot…, Stop All Bots…), the Dock badge's count of bots waiting on the
//          user, and the memory of the SynBot page for the next launch. Renders nothing.
// Layer: SynBot runtime (mounted once at the app root while SynBot is on)
// Exports: SynbotDesktopBridge

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { confirmAndStopAllBots } from "~/synbot/synbotActions";
import { rememberSynbotRoute } from "~/synbot/synbotRouteMemory";
import { synbotNeedsYouCount } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";

import { useBotEditor } from "./editor/botEditorStore";

export function SynbotDesktopBridge() {
  const navigate = useNavigate();
  const needsYou = useSynbotStore((store) => synbotNeedsYouCount(store.data));
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pageBot = useRouterState({
    select: (state) =>
      state.location.pathname === "/synbot"
        ? (state.location.search as { readonly bot?: string }).bot
        : undefined,
  });

  useEffect(() => {
    rememberSynbotRoute(pathname, pageBot);
  }, [pageBot, pathname]);

  // Bots that need the user join the Dock badge (the desktop adds them to unread notifications).
  useEffect(() => {
    window.desktopBridge?.setAttentionBadgeCount?.(needsYou);
  }, [needsYou]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    const openPage = () => {
      // Already there: keep the bot that is open.
      if (pathname === "/synbot") return;
      void navigate({ to: "/synbot", search: {} });
    };
    const unsubscribe = onMenuAction((action) => {
      switch (action) {
        case "synbot-open":
          openPage();
          return;
        case "synbot-new-bot":
          useBotEditor.getState().openCreate();
          openPage();
          return;
        case "synbot-stop-all":
          void confirmAndStopAllBots();
          return;
        default:
          return;
      }
    });
    return () => unsubscribe?.();
  }, [navigate, pathname]);

  return null;
}
