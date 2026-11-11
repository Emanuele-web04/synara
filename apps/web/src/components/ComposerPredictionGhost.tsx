// FILE: ComposerPredictionGhost.tsx
// Purpose: The composer prediction's ghost text: the dimmed suggestion followed by the Tab key
//          chip, wrapping up to three rows and ending with an ellipsis past them. It sits in the
//          editor's grid cell, so the composer grows with the rows it shows.
// Layer: Composer UI
// Exports: ComposerPredictionGhost

import { useLayoutEffect, useRef, useState } from "react";

import {
  COMPOSER_PREDICTION_ACCEPT_KEY_LABEL,
  COMPOSER_PREDICTION_MAX_ROWS,
  fitComposerPredictionText,
} from "~/lib/composerPrediction";
import { cn } from "~/lib/utils";
import {
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
} from "./chat/composerPickerStyles";
import { ShortcutKbd } from "./ui/kbd";

export function ComposerPredictionGhost({
  suggestion,
  layoutKey,
  className,
}: {
  suggestion: string;
  /** Changes when the composer switches layout, so the fit is redone before paint. */
  layoutKey?: string | undefined;
  className?: string | undefined;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [fitted, setFitted] = useState<{ source: string; text: string } | null>(null);
  const shown = fitted?.source === suggestion ? fitted.text : suggestion;

  useLayoutEffect(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;
    const fit = () => {
      const text = box.querySelector<HTMLElement>("[data-prediction-text]");
      const chip = box.querySelector<HTMLElement>("[data-prediction-chip]");
      const lineHeight = Number.parseFloat(getComputedStyle(box).lineHeight);
      // Hidden while dictating: keep the last fit until the box has a width again.
      if (!text || !chip || !Number.isFinite(lineHeight) || box.clientWidth <= 0) return;
      // Lay candidates out in an invisible copy at the same width, so the visible text
      // never shows an intermediate cut.
      const probeText = text.cloneNode(false) as HTMLElement;
      probe.replaceChildren(probeText, chip.cloneNode(true));
      const maxHeight = lineHeight * COMPOSER_PREDICTION_MAX_ROWS + 0.5;
      const next = fitComposerPredictionText(suggestion, (candidate) => {
        probeText.textContent = candidate;
        return probe.getBoundingClientRect().height <= maxHeight;
      });
      probe.replaceChildren();
      setFitted((current) =>
        current?.source === suggestion && current.text === next
          ? current
          : { source: suggestion, text: next },
      );
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [suggestion, layoutKey]);

  return (
    <div
      ref={boxRef}
      className={cn(
        "pointer-events-none relative min-w-0 break-words",
        COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
        className,
      )}
      data-testid="composer-prediction"
    >
      {/* The text and chip alone, so the single-row layout can measure their natural width. */}
      <span data-prediction-line="">
        <span className={COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME} data-prediction-text="">
          {shown}
        </span>
        {/* One line tall and top-aligned, so the chip is centered on the text's last row. */}
        <span className="ml-1.5 inline-flex h-[1lh] items-center align-top" data-prediction-chip="">
          <ShortcutKbd shortcutLabel={COMPOSER_PREDICTION_ACCEPT_KEY_LABEL} />
        </span>
      </span>
      <div ref={probeRef} aria-hidden className="invisible absolute inset-x-0 top-0" />
    </div>
  );
}
