// FILE: groupPanelSections.ts
// Purpose: The Group panel's secondary sections — ids, labels, and icons for
//          the rows under the Threads list, each of which opens its body in
//          place. Threads itself is always shown, so it is not listed here.
// Layer: Group panel shared descriptor (non-component module)

import { ClockIcon, GitPullRequestIcon, PageTextIcon, type LucideIcon } from "~/lib/icons";

export type GroupPanelSectionId = "pull-requests" | "automations" | "context";

export interface GroupPanelSectionDescriptor {
  readonly id: GroupPanelSectionId;
  readonly label: string;
  readonly icon: LucideIcon;
}

export const GROUP_PANEL_SECTIONS: readonly GroupPanelSectionDescriptor[] = [
  { id: "pull-requests", label: "Pull requests", icon: GitPullRequestIcon },
  { id: "automations", label: "Automations", icon: ClockIcon },
  { id: "context", label: "Context", icon: PageTextIcon },
];
