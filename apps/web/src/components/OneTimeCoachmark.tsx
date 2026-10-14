import {
  cloneElement,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react";

import { useAnnouncementSheetSlot, useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";

/** A remembered hint sharing the startup announcement slot with Activity and the tour. */
export function OneTimeCoachmark({
  storageKey,
  title,
  description,
  tooltip,
  tooltipSide = "right",
  children,
}: {
  storageKey: string;
  title: string;
  description: string;
  tooltip: string;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  const [visible, setVisible] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(storageKey) !== "seen";
    } catch {
      return true;
    }
  });
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const startupSettled = useAnnouncementSheetSlotStore((state) => state.startupSettled);
  const { open } = useAnnouncementSheetSlot(visible && startupSettled);
  const markSeen = () => {
    try {
      window.localStorage.setItem(storageKey, "seen");
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  };
  useEffect(() => {
    if (!open) return;
    try {
      window.localStorage.setItem(storageKey, "seen");
    } catch {
      // Keep the hint usable when persistence is unavailable.
    }
    const timeout = window.setTimeout(() => {
      setVisible(false);
      setTooltipOpen(false);
    }, 8_000);
    return () => window.clearTimeout(timeout);
  }, [open, storageKey]);

  return (
    <Tooltip
      open={visible ? open : tooltipOpen}
      onOpenChange={(next) => {
        if (!visible) setTooltipOpen(next);
      }}
    >
      <TooltipTrigger
        render={cloneElement(children, {
          onClick: (event) => {
            if (visible) markSeen();
            setVisible(false);
            setTooltipOpen(false);
            children.props.onClick?.(event);
          },
        })}
      />
      <TooltipPopup
        side={visible ? "right" : tooltipSide}
        align={visible ? "start" : "center"}
        sideOffset={visible ? 8 : 4}
        className={cn(
          // The shared popup surface paints its fill from unlayered CSS (`.app-popup-surface`),
          // which outranks a plain utility: without `!` the accent fill lost and the white
          // copy rendered on a white card, reading as an empty popup.
          visible &&
            "max-w-64 border-[var(--color-text-accent)] ![background:var(--color-text-accent)] text-white shadow-lg",
        )}
        viewportClassName={cn(visible && "px-3 py-2.5")}
      >
        {visible ? (
          <div className="text-left">
            <div className="text-ui leading-snug font-semibold">{title}</div>
            <div className="mt-0.5 text-ui-sm leading-4 text-white/85">{description}</div>
          </div>
        ) : (
          tooltip
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

export const TASKS_COACHMARK = {
  storageKey: "synara:tasks-onboarding:v1",
  title: "Tasks",
  description: "Keep your to-dos in one place and hand them to an agent when you’re ready.",
};

export function TasksCoachmark({
  children,
  tooltip,
}: {
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  tooltip: string;
}) {
  return (
    <OneTimeCoachmark {...TASKS_COACHMARK} tooltip={tooltip}>
      {children}
    </OneTimeCoachmark>
  );
}
