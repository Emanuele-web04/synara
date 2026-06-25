import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useDesktopTopBarTrafficLightGutterClassName } from "~/hooks/useDesktopTopBarGutter";
import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ReviewBrowserTabs } from "./ReviewBrowserTabs";

export interface ReviewRouteProjectOption {
  id: string;
  cwd: string;
  label: string;
}

export function ReviewRouteChrome(props: {
  cwd: string | null;
  reference?: string | null;
  currentTitle?: string | null;
  projects: ReadonlyArray<ReviewRouteProjectOption>;
  selectedProjectName: string | null;
  onProjectChange: (cwd: string) => void;
  children?: ReactNode;
}) {
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();

  return (
    <div
      className={cn(
        "review-route-strip flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b border-border/60 bg-background px-2.5",
        desktopTopBarTrafficLightGutterClassName,
      )}
    >
      <div className="flex shrink-0 items-center">
        <SidebarHeaderNavigationControls />
      </div>
      <ReviewBrowserTabs
        cwd={props.cwd}
        reference={props.reference ?? null}
        currentTitle={props.currentTitle ?? null}
      />
      {props.children}
      {props.projects.length > 1 ? (
        <Select
          value={props.cwd ?? ""}
          onValueChange={(value) => {
            if (!value) return;
            props.onProjectChange(value);
          }}
        >
          <SelectTrigger
            size="sm"
            className="h-8 min-w-32 max-w-44 shrink-0 rounded-lg border-border/40 bg-muted/25 text-[11px]"
            aria-label="Review project"
          >
            <SelectValue>{props.selectedProjectName}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {props.projects.map((project) => (
              <SelectItem key={project.id} value={project.cwd}>
                {project.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  );
}
