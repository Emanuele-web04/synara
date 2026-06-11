// FILE: Sidebar.picker.tsx
// Purpose: Segmented Threads/Workspace view toggle for the sidebar.
// Layer: Sidebar UI (props-only, no store/hooks).
// Exports: SidebarSegmentedPicker

import { cn } from "~/lib/utils";
import { SIDEBAR_SEGMENTED_PICKER_ACTIVE_CLASS_NAME } from "./chat/composerPickerStyles";

export function SidebarSegmentedPicker({
  activeView,
  onSelectView,
}: {
  activeView: "threads" | "workspace";
  onSelectView: (view: "threads" | "workspace") => void;
}) {
  return (
    <div className="px-3 pb-2.5">
      <div className="sidebar-segmented-picker inline-flex w-full rounded-lg p-0.5">
        {(["threads", "workspace"] as const).map((view) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              type="button"
              data-sidebar-segmented-active={active ? "true" : undefined}
              className={cn(
                "flex-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                active
                  ? SIDEBAR_SEGMENTED_PICKER_ACTIVE_CLASS_NAME
                  : "text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
              )}
              onClick={() => onSelectView(view)}
            >
              {view === "threads" ? "Threads" : "Workspace"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
