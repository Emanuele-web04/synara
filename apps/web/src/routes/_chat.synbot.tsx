// FILE: _chat.synbot.tsx
// Purpose: The SynBot page (Beta): HoloBot's sidebar in the rail panel, the selected bot's
//          thread in the main column. `?bot=<id>` picks the bot (SynBot without it); `?task=` opens
//          a task's own thread in the right pane.
// Layer: Route

import { createFileRoute, redirect } from "@tanstack/react-router";

import { SYNBOT_ON } from "~/betaFeatures";
import SynbotPage from "~/components/synbot/shell/SynbotPage";

export interface SynbotSearch {
  readonly bot?: string;
  readonly task?: string;
  readonly new?: "bot";
}

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

export const Route = createFileRoute("/_chat/synbot")({
  validateSearch: (search: Record<string, unknown>): SynbotSearch => {
    const bot = text(search.bot);
    const task = text(search.task);
    return {
      ...(bot ? { bot } : {}),
      ...(task ? { task } : {}),
      ...(search.new === "bot" ? { new: "bot" as const } : {}),
    };
  },
  beforeLoad: () => {
    if (!SYNBOT_ON) throw redirect({ to: "/", replace: true });
  },
  component: SynbotPage,
});
