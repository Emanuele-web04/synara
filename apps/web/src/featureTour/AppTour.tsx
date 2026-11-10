// FILE: AppTour.tsx
// Purpose: The app tour: the workspace dims, the real control a step is about gets a
//          ring, and a step card with a small animated scene floats beside it. Next,
//          Back, the dots and ← → walk the steps; ✕, Escape or a click outside ends it.
// Layer: Root web overlay (mounted by FeatureTourDialog, which owns when it runs)
// Exports: AppTour
//
// The card is a modal Base UI dialog positioned beside its anchor, so focus is trapped
// and restored like every other dialog. The spotlight is that dialog's backdrop: a
// rounded hole cut with a spread shadow, gliding between anchors.

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { useAnnouncementSheetSlot } from "~/components/announcementSheetSlot";
import { DialogHeroBand } from "~/components/DialogHeroBand";
import { markCoachmarksSeen } from "~/components/OneTimeCoachmark";
import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogPortal, DialogTitle } from "~/components/ui/dialog";
import { useTranslation } from "~/i18n";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { AppTourPreview } from "./AppTourPreview";
import { APP_TOUR_ANCHOR_ATTRIBUTE, APP_TOUR_STEPS, type AppTourStep } from "./content";
import { placeTourCard, resolveTourSteps, type TourRect } from "./logic";

const CARD_WIDTH = 340;
const CARD_HEIGHT_ESTIMATE = 330;
const VIEWPORT_MARGIN = 12;
const SPOTLIGHT_PADDING = 5;
const CARET_SIZE = 10;
/** The card's hero band height (`min-h-36`); a caret beside it takes the band's tint. */
const CARD_BAND_HEIGHT = 144;
const GLIDE_CLASS_NAME = "duration-[420ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]";

/**
 * The first control carrying the step's anchor that the reader can actually see (the rail
 * and panel can both carry one). Its center must be inside the window and hit the control:
 * a collapsed sidebar stays laid out, slid off canvas or under the rail. Run before the
 * tour's own overlay mounts, which would otherwise win every hit test.
 */
function findVisibleAnchor(anchor: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(
    `[${APP_TOUR_ANCHOR_ATTRIBUTE}="${anchor}"]`,
  )) {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit && element.contains(hit)) return element;
  }
  return null;
}

function sameRect(a: TourRect | null, b: TourRect | null) {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.left === b.left &&
      a.top === b.top &&
      a.width === b.width &&
      a.height === b.height)
  );
}

/** Tracks the anchor's box while the step shows: resizes, scrolls, and layout shifts. */
function useAnchorRect(element: HTMLElement | null): TourRect | null {
  const [measured, setMeasured] = useState<{ element: HTMLElement; rect: TourRect } | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const measure = () => {
      // A control that remounted mid-step keeps the ring where it last was.
      if (!element.isConnected) return;
      const box = element.getBoundingClientRect();
      const rect = { left: box.left, top: box.top, width: box.width, height: box.height };
      setMeasured((previous) =>
        previous?.element === element && sameRect(previous.rect, rect)
          ? previous
          : { element, rect },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(document.documentElement);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [element]);
  return element && measured?.element === element ? measured.rect : null;
}

function useViewport() {
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return viewport;
}

export function AppTour(props: { open: boolean; replay: boolean; onDismiss: () => void }) {
  const { t } = useTranslation();
  // Startup surfaces share one slot so the tour never stacks on an announcement. Replays
  // are deliberate and may run after a startup handoff.
  const { open } = useAnnouncementSheetSlot(props.open, props.replay);
  const [entries, setEntries] = useState<ReadonlyArray<{ step: AppTourStep; anchored: boolean }>>(
    [],
  );
  const [anchors, setAnchors] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map());
  const [index, setIndex] = useState(0);
  // Steps are resolved two frames after the tour opens, so a replay that just left Settings
  // finds the workspace mounted: hidden rail items and a collapsed sidebar's controls are
  // skipped, and with no controls on screen at all the cards are centered instead. Entries outlive a close so the card can
  // play its exit; `resolved` keeps a reopen from flashing the previous step.
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    if (!open) return;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const found = new Map<string, HTMLElement>();
        for (const step of APP_TOUR_STEPS) {
          const element = findVisibleAnchor(step.anchor);
          if (element) found.set(step.anchor, element);
        }
        setAnchors(found);
        setEntries(resolveTourSteps(APP_TOUR_STEPS, (anchor) => found.has(anchor)));
        setIndex(0);
        setResolved(true);
        // The tour covers Activity and Tasks; their one-time hints would only repeat it.
        markCoachmarksSeen();
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      setResolved(false);
    };
  }, [open]);

  const entry = entries[Math.min(index, entries.length - 1)];
  const showing = open && resolved && entry !== undefined;
  const anchorRect = useAnchorRect(
    showing && entry.anchored ? (anchors.get(entry.step.anchor) ?? null) : null,
  );
  const viewport = useViewport();

  const cardRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(CARD_HEIGHT_ESTIMATE);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!showing || !card) return;
    const measure = () => setCardHeight(card.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [showing, entry]);
  // Position changes glide only after the first placement, so opening never slides in.
  const [glide, setGlide] = useState(false);
  useEffect(() => {
    if (!showing) return;
    const frame = window.requestAnimationFrame(() => setGlide(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setGlide(false);
    };
  }, [showing]);

  const cardWidth = Math.min(CARD_WIDTH, viewport.width - VIEWPORT_MARGIN * 2);
  const spotlight = anchorRect
    ? {
        left: anchorRect.left - SPOTLIGHT_PADDING,
        top: anchorRect.top - SPOTLIGHT_PADDING,
        width: anchorRect.width + SPOTLIGHT_PADDING * 2,
        height: anchorRect.height + SPOTLIGHT_PADDING * 2,
      }
    : null;
  const placement = placeTourCard({
    anchor: spotlight,
    card: { width: cardWidth, height: cardHeight },
    viewport,
    margin: VIEWPORT_MARGIN,
  });

  const total = entries.length;
  const last = index >= total - 1;
  const go = (next: number) => setIndex(Math.max(0, Math.min(total - 1, next)));
  const advance = () => (last ? props.onDismiss() : go(index + 1));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      go(index + (event.key === "ArrowRight" ? 1 : -1));
    } else if (event.key === "Enter" && event.target === focusRef.current) {
      event.preventDefault();
      advance();
    }
  };

  return (
    <Dialog
      open={showing}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) props.onDismiss();
      }}
    >
      <DialogPortal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none">
          {spotlight ? (
            <span
              className={cn(
                "absolute rounded-[12px] motion-reduce:transition-none",
                glide && cn("transition-[left,top,width,height]", GLIDE_CLASS_NAME),
              )}
              style={{
                ...spotlight,
                boxShadow: "0 0 0 2px var(--color-sky-500), 0 0 0 9999px rgb(0 0 0 / 0.5)",
              }}
            >
              <span className="scene-halo absolute -inset-1.5 rounded-[15px] border-2 border-sky-400" />
            </span>
          ) : (
            <span className="absolute inset-0 bg-black/50" />
          )}
        </DialogPrimitive.Backdrop>
        {entry ? (
          <DialogPrimitive.Popup
            ref={cardRef}
            data-feature-tour=""
            data-tour-side={placement.side}
            initialFocus={focusRef}
            onKeyDown={onKeyDown}
            className={cn(
              "fixed z-50 rounded-[20px] text-[var(--color-text-foreground)] outline-none",
              "shadow-[0_28px_60px_-20px_rgba(0,0,0,0.45)] dark:shadow-[0_28px_60px_-16px_rgba(0,0,0,0.8)]",
              "transition-[opacity,scale] duration-200 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 motion-reduce:transition-none",
              glide && cn("transition-[opacity,scale,left,top]", GLIDE_CLASS_NAME),
            )}
            style={{ left: placement.left, top: placement.top, width: cardWidth }}
          >
            {placement.caret !== null ? (
              <Caret
                side={placement.side}
                offset={placement.caret}
                onBand={
                  (placement.side === "right" || placement.side === "left") &&
                  placement.caret < CARD_BAND_HEIGHT
                }
              />
            ) : null}
            <div
              ref={focusRef}
              tabIndex={-1}
              className="relative flex max-h-[calc(100dvh-24px)] flex-col overflow-y-auto rounded-[20px] border border-[color:var(--color-border-light)] bg-popover outline-none"
            >
              <DialogHeroBand className="h-auto min-h-36 py-5">
                <AppTourPreview key={entry.step.id} step={entry.step.id} />
              </DialogHeroBand>
              <DialogPrimitive.Close
                aria-label={t("onboarding:appTourClose")}
                className="absolute end-2.5 top-2.5 bg-popover/80 backdrop-blur-sm"
                render={<Button size="icon-sm" variant="ghost" />}
              >
                <XIcon />
              </DialogPrimitive.Close>

              {/* The copy below remounts per step; this stable region announces the move. */}
              <p aria-live="polite" aria-atomic="true" className="sr-only">
                {t("onboarding:appTourStepOf", { current: index + 1, total })}
                {": "}
                {t(entry.step.titleKey)}
              </p>
              <div
                key={entry.step.id}
                className="sidebar-surface-enter flex flex-col gap-1 px-5 pt-4"
              >
                <span className="text-ui-xs font-semibold text-sky-600 tabular-nums dark:text-sky-400">
                  {t("onboarding:appTourStepOf", { current: index + 1, total })}
                  {" · "}
                  {t(entry.step.placeKey)}
                </span>
                <DialogTitle className="text-[17px] leading-snug tracking-[-0.01em]">
                  {t(entry.step.titleKey)}
                </DialogTitle>
                <DialogDescription className="text-ui leading-normal">
                  {t(entry.step.descriptionKey)}
                </DialogDescription>
              </div>

              <div className="flex items-center gap-1.5 px-5 pt-4 pb-4">
                <nav aria-label={t("onboarding:appTourSteps")} className="-ms-1.5 me-auto flex">
                  {entries.map((item, position) => (
                    <button
                      key={item.step.id}
                      type="button"
                      aria-label={t("onboarding:show", { value0: t(item.step.titleKey) })}
                      aria-current={position === index ? "step" : undefined}
                      onClick={() => go(position)}
                      className="flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        className={cn(
                          "h-1.5 rounded-full transition-[width,background-color] duration-200 motion-reduce:transition-none",
                          position === index ? "w-4 bg-foreground" : "w-1.5 bg-muted-foreground/30",
                        )}
                      />
                    </button>
                  ))}
                </nav>
                {index > 0 ? (
                  <Button size="sm" variant="secondary" onClick={() => go(index - 1)}>
                    {t("common:app_back")}
                  </Button>
                ) : null}
                <Button size="sm" onClick={advance}>
                  {last ? t("onboarding:appTourDone") : t("onboarding:common_next")}
                </Button>
              </div>
            </div>
          </DialogPrimitive.Popup>
        ) : null}
      </DialogPortal>
    </Dialog>
  );
}

/** A small notch on the card's facing edge, pointing at the anchor. */
function Caret(props: {
  side: "right" | "bottom" | "left" | "top" | "center";
  offset: number;
  onBand: boolean;
}) {
  const half = CARET_SIZE / 2;
  const style: CSSProperties =
    props.side === "right"
      ? { left: -half, top: props.offset - half }
      : props.side === "left"
        ? { right: -half, top: props.offset - half }
        : props.side === "bottom"
          ? { top: -half, left: props.offset - half }
          : { bottom: -half, left: props.offset - half };
  return (
    <span
      aria-hidden
      className="absolute rotate-45 overflow-hidden rounded-[2px] border border-[color:var(--color-border-light)] bg-popover"
      style={{ ...style, width: CARET_SIZE, height: CARET_SIZE }}
    >
      {props.onBand || props.side === "bottom" ? (
        <span className="absolute inset-0 bg-muted/60" />
      ) : null}
    </span>
  );
}
