// FILE: _chat.synbot.tsx
// Purpose: The SynBot page (Beta): the bot list in the rail panel, the selected bot's thread in
//          the main column. `?bot=<id>` picks the bot; without it SynBot is shown.
// Layer: Route

import { createFileRoute, redirect } from "@tanstack/react-router";

import { SYNBOT_ON } from "~/betaFeatures";
import SynbotView from "~/components/synbot/SynbotView";

export interface SynbotSearch {
  readonly bot?: string;
}

export const Route = createFileRoute("/_chat/synbot")({
  validateSearch: (search: Record<string, unknown>): SynbotSearch =>
    typeof search.bot === "string" && search.bot.length > 0 ? { bot: search.bot } : {},
  beforeLoad: () => {
    if (!SYNBOT_ON) throw redirect({ to: "/", replace: true });
  },
  component: SynbotView,
});
