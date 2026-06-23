// FILE: EnvironmentToggle.tsx
// Purpose: The single chat-header "Environment" button that replaces the former
//          Open-in-editor + git-actions + diff-toggle cluster. It toggles the Environment
//          panel overlay, which is always pinned to the top-right of the chat column
//          (with matching p-3 gutters). When the right dock is closed the overlay also
//          reserves transcript/composer inset; when the dock is open it overlays only.
// Layer: Chat header control

import type { OrchestrationThreadRuntime } from "@t3tools/contracts";
import { FiServer } from "react-icons/fi";
import { WindowIcon } from "~/lib/icons";
import {
  resolveRuntimeHeaderPresentation,
  type RuntimeStatusTone,
} from "~/lib/runtimePresentation";
import { cn } from "~/lib/utils";

import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CHAT_HEADER_TOGGLE_CLASS_NAME, SurfaceChipIcon } from "../chatHeaderControls";

export interface EnvironmentToggleState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Icon-only footprint matching the header diff toggle's collapsed (no-badge) size.
const TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
);

const TONE_DOT_CLASS: Record<RuntimeStatusTone, string> = {
  active: "bg-success",
  pending: "bg-warning animate-pulse motion-reduce:animate-none",
  idle: "bg-[var(--color-text-foreground-secondary)]",
  terminal: "bg-[var(--color-text-foreground-secondary)]",
  error: "bg-destructive",
};

const TONE_TOGGLE_CLASS: Record<RuntimeStatusTone, string> = {
  active:
    "border-sky-500/35 bg-sky-500/10 text-sky-700 hover:bg-sky-500/15 data-[state=on]:bg-sky-500/15 dark:text-sky-200",
  pending:
    "border-amber-500/35 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 data-[state=on]:bg-amber-500/15 dark:text-amber-200",
  idle: "",
  terminal: "",
  error:
    "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 data-[state=on]:bg-destructive/15",
};

export function EnvironmentToggle({
  environment,
  runtime,
}: {
  environment: EnvironmentToggleState;
  runtime?: OrchestrationThreadRuntime | null | undefined;
}) {
  const runtimePresentation = resolveRuntimeHeaderPresentation(runtime);
  const tooltip = runtimePresentation.show ? runtimePresentation.text : "Environment";
  const ariaLabel = runtimePresentation.show
    ? `Toggle environment panel, ${runtimePresentation.text}`
    : "Toggle environment panel";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={cn(
              TOGGLE_CLASS_NAME,
              runtimePresentation.show ? TONE_TOGGLE_CLASS[runtimePresentation.tone] : null,
            )}
            pressed={environment.open}
            onPressedChange={environment.onOpenChange}
            aria-label={ariaLabel}
            title={tooltip}
            variant="default"
            size="xs"
          >
            {runtimePresentation.show ? (
              <span className="relative inline-flex size-4 items-center justify-center">
                <FiServer className="size-3.5" aria-hidden />
                <span
                  className={cn(
                    "absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-1 ring-background",
                    TONE_DOT_CLASS[runtimePresentation.tone],
                  )}
                  aria-hidden
                />
              </span>
            ) : (
              <SurfaceChipIcon icon={WindowIcon} className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
