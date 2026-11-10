import {
  cloneElement,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react";
import { create } from "zustand";

import { useAnnouncementSheetSlot, useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";

export const ACTIVITY_COACHMARK_STORAGE_KEY = "synara:activity-onboarding:v1";

function hasSeen(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(storageKey) === "seen";
  } catch {
    return false;
  }
}

function markSeen(storageKey: string) {
  try {
    window.localStorage.setItem(storageKey, "seen");
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

/** Bumped when hints are acknowledged elsewhere, so mounted coachmarks re-read storage. */
const useCoachmarkAcknowledgements = create<{ epoch: number }>(() => ({ epoch: 0 }));

/** The app tour points at Activity and Tasks itself; their one-time hints would repeat it. */
export function markCoachmarksSeen() {
  markSeen(ACTIVITY_COACHMARK_STORAGE_KEY);
  markSeen(TASKS_COACHMARK.storageKey);
  useCoachmarkAcknowledgements.setState(({ epoch }) => ({ epoch: epoch + 1 }));
}

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
  const [pending, setPending] = useState(
    () => typeof window !== "undefined" && !hasSeen(storageKey),
  );
  const visible = pending;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const startupSettled = useAnnouncementSheetSlotStore((state) => state.startupSettled);
  const { open } = useAnnouncementSheetSlot(visible && startupSettled);
  // A hint the app tour acknowledged while this control was mounted never shows, and the
  // control keeps its ordinary tooltip.
  const acknowledgements = useCoachmarkAcknowledgements((state) => state.epoch);
  useEffect(() => {
    if (acknowledgements > 0 && pending && !open && hasSeen(storageKey)) setPending(false);
  }, [acknowledgements, open, pending, storageKey]);
  useEffect(() => {
    if (!open) return;
    markSeen(storageKey);
    const timeout = window.setTimeout(() => {
      setPending(false);
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
            if (visible) markSeen(storageKey);
            setPending(false);
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
  titleKey: "chat:tasks",
  description: "Keep your to-dos in one place and hand them to an agent when you’re ready.",
  descriptionKey: "common:keepYourToDosInOnePlaceAndHand",
};

export function TasksCoachmark({
  children,
  tooltip,
}: {
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  tooltip: string;
}) {
  const { t } = useTranslation();
  return (
    <OneTimeCoachmark
      {...TASKS_COACHMARK}
      title={t(TASKS_COACHMARK.titleKey)}
      description={t(TASKS_COACHMARK.descriptionKey)}
      tooltip={tooltip}
    >
      {children}
    </OneTimeCoachmark>
  );
}
