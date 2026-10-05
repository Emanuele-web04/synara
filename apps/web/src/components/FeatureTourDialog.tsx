import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { isBetaFeatureOn } from "~/betaFeatures";
import { FEATURE_TOUR_SLIDES } from "~/featureTour/content";
import { FeatureTourPreview } from "~/featureTour/FeatureTourPreview";
import {
  EMPTY_FEATURE_TOUR_SEEN,
  FEATURE_TOUR_STORAGE_KEY,
  FeatureTourSeenSchema,
  useFeatureTourStore,
} from "~/featureTour/store";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { ChevronLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { useProjectImportAnnouncement } from "~/projectImport/useProjectImportAnnouncement";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
import { AnnouncementSheet } from "./AnnouncementSheet";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { Button } from "./ui/button";

/** Wait for other modals to leave the DOM, including their exit transitions. */
function useOtherDialogOpen(enabled: boolean) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const update = () =>
      setOpen(
        Boolean(
          document.querySelector('[role="dialog"]:not([data-feature-tour]), [role="alertdialog"]'),
        ),
      );
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role"],
    });
    return () => observer.disconnect();
  }, [enabled]);
  return enabled && open;
}

export function FeatureTourDialog() {
  const installation = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.worktreesDir,
  }).data;
  const [seen, setSeen] = useLocalStorage(
    FEATURE_TOUR_STORAGE_KEY,
    EMPTY_FEATURE_TOUR_SEEN,
    FeatureTourSeenSchema,
  );
  const startupBlocking = useOnboardingDialogStore(
    (state) => !state.startupGateSettled || state.isOpen || state.betaWelcomePending,
  );
  const importing = useProjectImportDialogStore((state) => state.isOpen);
  const importAnnouncement = useProjectImportAnnouncement();
  const owner = useAnnouncementSheetSlotStore((state) => state.owner);
  const handedOff = useAnnouncementSheetSlotStore((state) => state.handedOff);
  const settleStartup = useAnnouncementSheetSlotStore((state) => state.settleStartup);
  const replay = useFeatureTourStore((state) => state.replay);
  const needsTour = Boolean(
    installation && (replay || (!handedOff && !seen.includes(installation))),
  );
  const otherDialog = useOtherDialogOpen(needsTour);
  const [ready, setReady] = useState(false);
  const blocked =
    startupBlocking || importing || (importAnnouncement.visible && !handedOff) || otherDialog;
  // This is the last startup surface, mounted after Safari/AppSnap probes settle.
  // Passive coachmarks wait for the tour to be seen or dismissed before claiming.
  useEffect(() => {
    if (installation && !needsTour && !blocked && !handedOff) settleStartup();
  }, [blocked, handedOff, installation, needsTour, settleStartup]);
  // AppSnap and Safari probes are resolved by the parent before this mounts. The
  // quiet interval lets the announcement queue and dialog exit animation settle.
  useEffect(() => {
    if (blocked || owner !== null || ready || (handedOff && !replay)) return;
    const timer = window.setTimeout(() => setReady(true), 350);
    return () => window.clearTimeout(timer);
  }, [blocked, handedOff, owner, ready, replay]);

  const dismiss = () => {
    if (installation)
      setSeen((current) => (current.includes(installation) ? current : [...current, installation]));
    useFeatureTourStore.getState().close();
  };
  const slides = FEATURE_TOUR_SLIDES.filter(
    (slide) => !slide.feature || isBetaFeatureOn(slide.feature),
  );
  const open = Boolean(
    installation && ready && !blocked && (replay || (!handedOff && !seen.includes(installation))),
  );
  // Replays are deliberate user actions and can run after a startup handoff.
  // They still wait for every currently open dialog.
  return (
    <FeatureTourSlides
      key={replay ? "replay" : "startup"}
      open={open}
      slides={slides}
      onDismiss={dismiss}
      replay={replay}
    />
  );
}

function FeatureTourSlides({
  open,
  slides,
  onDismiss,
  replay,
}: {
  open: boolean;
  slides: typeof FEATURE_TOUR_SLIDES;
  onDismiss: () => void;
  replay: boolean;
}) {
  const [index, setIndex] = useState(0);
  const slide = slides[index];
  if (!slide) return null;
  return (
    <AnnouncementSheet
      open={open}
      presentation="tour"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          setIndex((current) =>
            Math.max(
              0,
              Math.min(slides.length - 1, current + (event.key === "ArrowRight" ? 1 : -1)),
            ),
          );
        }
      }}
      allowAfterHandOff={replay}
      hero={<FeatureTourPreview slide={slide} />}
      title={slide.title}
      description={slide.description}
      details={
        <div className="min-h-[104px] shrink-0 pt-3">
          <p aria-live="polite" aria-atomic="true" className="sr-only">
            Since 0.9.2, {index + 1} of {slides.length}
          </p>
          <ul className="space-y-1.5 text-ui leading-snug text-muted-foreground">
            {slide.highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
        </div>
      }
      navigation={
        <nav
          aria-label="Feature tour slides"
          className="-ms-1.5 flex gap-0.5 pt-2 max-sm:basis-full max-sm:justify-center sm:me-auto sm:pt-0"
        >
          {slides.map((item, position) => (
            <button
              key={item.id}
              type="button"
              aria-label={`Show ${item.title}`}
              aria-current={position === index ? "step" : undefined}
              onClick={() => setIndex(position)}
              className="flex size-7 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  "h-1.5 rounded-full",
                  position === index ? "w-5 bg-foreground" : "w-1.5 bg-muted-foreground/30",
                )}
              />
            </button>
          ))}
        </nav>
      }
      navigationEnd={
        index > 0 ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back"
            className="rounded-[10px]"
            onClick={() => setIndex(index - 1)}
          >
            <ChevronLeftIcon />
          </Button>
        ) : null
      }
      {...(index === slides.length - 1 ? {} : { dismissLabel: "Skip tour" })}
      confirmLabel={index === slides.length - 1 ? "Start exploring" : "Next"}
      handOffOnConfirm={false}
      onDismiss={onDismiss}
      onConfirm={() => (index === slides.length - 1 ? onDismiss() : setIndex(index + 1))}
    />
  );
}
