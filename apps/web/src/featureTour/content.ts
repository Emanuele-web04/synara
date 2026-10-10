import type { LucideIcon } from "~/lib/icons";
import { Columns2Icon, GitPullRequestIcon, UsersIcon, WorkflowIcon } from "~/lib/icons";

export interface FeatureTourSlide {
  id: "workspace" | "accounts" | "review" | "hubs";
  title: string;
  description: string;
  highlights: readonly string[];
  icon: LucideIcon;
  feature?: string;
}

// Curated from v0.9.2..HEAD. Keep this tour about changes, not the full feature inventory.
export const FEATURE_TOUR_SLIDES: readonly FeatureTourSlide[] = [
  {
    id: "workspace",
    title: "A new home for your work",
    description:
      "A slimmer rail, open-chat tabs, and refreshed icons put your workspace within reach.",
    highlights: [
      "Customize the rail and keep your favorite tools close.",
      "Move between open chats or work in split panes.",
      "Make it yours with project icons, colors, and window appearance.",
    ],
    icon: Columns2Icon,
  },
  {
    id: "accounts",
    title: "Your agents, together",
    description:
      "Use multiple accounts from the same provider and choose the right one for each chat.",
    highlights: [
      "Add and sign in to accounts from provider settings.",
      "See account names in the model picker and track their usage.",
      "Hand work to another provider from the picker, in the same thread.",
    ],
    icon: UsersIcon,
  },
  {
    id: "review",
    title: "From review to the next change",
    description:
      "The redesigned Code review page brings pull requests, issues, and agent actions into one place.",
    highlights: [
      "Browse and sort the list, then inspect a pull request or issue.",
      "Discuss changes in a side chat beside the details.",
      "Ask an agent to review or continue the work.",
    ],
    icon: GitPullRequestIcon,
  },
  {
    id: "hubs",
    title: "Give bigger work a team",
    description:
      "Hubs bring a coordinator and worker agents together around a shared project in Synara Beta.",
    highlights: [
      "Keep shared context in the Hub Library and track delegated work.",
      "Plan Tasks in a list or Kanban board and hand them to agents.",
      "Open Inbox for today's tasks, review requests, and activity recap.",
    ],
    icon: WorkflowIcon,
    feature: "groups",
  },
];
