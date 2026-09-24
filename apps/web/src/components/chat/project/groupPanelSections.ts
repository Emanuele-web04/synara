// FILE: groupPanelSections.ts
// Purpose: The Group panel's bottom-bar section registry — ids, labels, and
//          icons shared by the bar component and the panel that maps section
//          state to its disclosure bodies.
// Layer: Group panel shared descriptor (non-component module so the bar's
//        home file exports only components)

import {
  ChatBubbleIcon,
  ClockIcon,
  GitPullRequestIcon,
  PageTextIcon,
  type LucideIcon,
} from "~/lib/icons";

export type GroupPanelSectionId = "threads" | "pull-requests" | "automations" | "context";

export interface GroupPanelSectionDescriptor {
  readonly id: GroupPanelSectionId;
  readonly label: string;
  readonly icon: LucideIcon;
}

export const GROUP_PANEL_SECTIONS: readonly GroupPanelSectionDescriptor[] = [
  { id: "threads", label: "Threads", icon: ChatBubbleIcon },
  { id: "pull-requests", label: "Pull requests", icon: GitPullRequestIcon },
  { id: "automations", label: "Automations", icon: ClockIcon },
  { id: "context", label: "Context", icon: PageTextIcon },
];
