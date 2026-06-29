import { useMemo, useState, type ReactElement } from "react";

import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";
import { SidebarInset } from "../ui/sidebar";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import { TranscriptStateComposer } from "./TranscriptStateComposer";
import { TranscriptStateInspector } from "./TranscriptStateInspector";
import type { TranscriptStatePlaygroundLayout } from "./TranscriptStatePlayground.types";
import { TranscriptStatePreview } from "./TranscriptStatePreview";
import { TranscriptStateScenarioPanel } from "./TranscriptStateScenarioPanel";
import { TranscriptStateWorkbenchHeader } from "./TranscriptStateWorkbenchHeader";
import {
  buildTranscriptScenarioState,
  DEFAULT_TRANSCRIPT_SCENARIO,
  TRANSCRIPT_SCENARIOS,
  type TranscriptScenarioId,
  type TranscriptScenarioState,
} from "./transcriptStateFixtures";

export function TranscriptStatePlayground(): ReactElement {
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();
  const [scenarioId, setScenarioId] = useState<TranscriptScenarioId>("sent");
  const selectedScenario =
    TRANSCRIPT_SCENARIOS.find((scenario) => scenario.id === scenarioId) ??
    DEFAULT_TRANSCRIPT_SCENARIO;
  const [elapsedSeconds, setElapsedSeconds] = useState(selectedScenario.defaultElapsedSeconds);
  const state = useMemo(
    () => buildTranscriptScenarioState(scenarioId, elapsedSeconds),
    [elapsedSeconds, scenarioId],
  );

  const selectScenario = (nextScenarioId: TranscriptScenarioId): void => {
    const nextScenario =
      TRANSCRIPT_SCENARIOS.find((scenario) => scenario.id === nextScenarioId) ??
      DEFAULT_TRANSCRIPT_SCENARIO;
    setScenarioId(nextScenario.id);
    setElapsedSeconds(nextScenario.defaultElapsedSeconds);
  };

  return (
    <SidebarInset className="flex min-h-svh flex-col bg-background text-foreground">
      <header
        className={cn(
          "drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-3",
          trafficLightGutter,
          windowControlsGutter,
        )}
      >
        <SidebarHeaderNavigationControls />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">Transcript State Lab</h1>
          <p className="truncate text-xs text-muted-foreground">
            {state.scenario.phaseLabel} - {state.scenario.label}
          </p>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-3 lg:overflow-hidden">
        <div data-uidotsh-pick="Transcript lab layout" className="contents">
          <div data-uidotsh-option="Scenario rail (current)" className="contents [&[hidden]]:hidden">
            <LabLayout
              layout="rail"
              state={state}
              selectedScenarioId={scenarioId}
              elapsedSeconds={elapsedSeconds}
              onElapsedSecondsChange={setElapsedSeconds}
              onSelectScenario={selectScenario}
            />
          </div>
          <div data-uidotsh-option="Transcript focus" className="contents [&[hidden]]:hidden" hidden>
            <LabLayout
              layout="focus"
              state={state}
              selectedScenarioId={scenarioId}
              elapsedSeconds={elapsedSeconds}
              onElapsedSecondsChange={setElapsedSeconds}
              onSelectScenario={selectScenario}
            />
          </div>
          <div data-uidotsh-option="Inspector focus" className="contents [&[hidden]]:hidden" hidden>
            <LabLayout
              layout="inspector"
              state={state}
              selectedScenarioId={scenarioId}
              elapsedSeconds={elapsedSeconds}
              onElapsedSecondsChange={setElapsedSeconds}
              onSelectScenario={selectScenario}
            />
          </div>
        </div>
      </main>
    </SidebarInset>
  );
}

function LabLayout({
  layout,
  state,
  selectedScenarioId,
  elapsedSeconds,
  onElapsedSecondsChange,
  onSelectScenario,
}: {
  readonly layout: TranscriptStatePlaygroundLayout;
  readonly state: TranscriptScenarioState;
  readonly selectedScenarioId: TranscriptScenarioId;
  readonly elapsedSeconds: number;
  readonly onElapsedSecondsChange: (value: number) => void;
  readonly onSelectScenario: (scenarioId: TranscriptScenarioId) => void;
}): ReactElement {
  const focusLayout = layout === "focus";
  const inspectorLayout = layout === "inspector";
  const layoutLabelId = `transcript-lab-${layout}-label`;

  return (
    <section
      className={cn(
        "grid min-h-full min-w-0 gap-3 lg:h-full lg:min-h-0",
        focusLayout
          ? "lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_minmax(0,1fr)]"
          : inspectorLayout
            ? "lg:grid-cols-[320px_minmax(0,1fr)_300px] lg:grid-rows-[auto_minmax(0,1fr)]"
            : "lg:grid-cols-[300px_minmax(0,1fr)_300px] lg:grid-rows-[auto_minmax(0,1fr)]",
      )}
      aria-labelledby={layoutLabelId}
    >
      <h2 id={layoutLabelId} className="sr-only">
        Transcript lifecycle emulator
      </h2>
      <TranscriptStateWorkbenchHeader state={state} />
      <TranscriptStateScenarioPanel
        compact={focusLayout}
        layout={layout}
        selectedScenarioId={selectedScenarioId}
        elapsedSeconds={elapsedSeconds}
        onElapsedSecondsChange={onElapsedSecondsChange}
        onSelectScenario={onSelectScenario}
      />
      <div className="grid min-h-0 min-w-0 gap-3 lg:grid-rows-[minmax(0,1fr)_auto]">
        <TranscriptStatePreview
          state={state}
          className="h-[min(58svh,520px)] min-h-[360px] lg:h-full lg:min-h-0"
        />
        <TranscriptStateComposer state={state} />
      </div>
      <TranscriptStateInspector state={state} compact={focusLayout} layout={layout} />
    </section>
  );
}
