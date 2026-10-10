import { TourShortcutList } from "./FeatureTourStep";

export function DoneStep() {
  return (
    <div className="flex flex-col gap-3.5 px-[120px]">
      <p className="text-ui-sm font-medium tracking-[0.04em] text-muted-foreground/70 uppercase">
        Shortcuts worth learning today
      </p>
      <TourShortcutList />
    </div>
  );
}
