import {
  BotIcon,
  BrainIcon,
  BugIcon,
  ClockIcon,
  EraserIcon,
  FastModeIcon,
  GitForkIcon,
  GoalIcon,
  InfoIcon,
  ListTodoIcon,
  type LucideIcon,
  MessageCircleIcon,
  Minimize2,
  TemporaryThreadIcon,
} from "./icons";

// reuse the app's icon components so commands stay coherent with plan/fork/review/model everywhere; no bespoke glyphs — map to ~/lib/icons
export const SLASH_COMMAND_ICONS: Record<string, LucideIcon> = {
  clear: EraserIcon,
  compact: Minimize2,
  model: BrainIcon,
  fast: FastModeIcon,
  plan: ListTodoIcon,
  debug: BugIcon,
  default: MessageCircleIcon,
  review: BugIcon,
  fork: GitForkIcon,
  side: TemporaryThreadIcon,
  status: InfoIcon,
  subagents: BotIcon,
  feedback: BugIcon,
  automation: ClockIcon,
  goal: GoalIcon,
};

export function slashCommandIcon(command: string, fallback: LucideIcon): LucideIcon {
  return SLASH_COMMAND_ICONS[command] ?? fallback;
}
