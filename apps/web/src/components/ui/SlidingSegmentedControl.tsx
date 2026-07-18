import { type ReactNode, useCallback, useLayoutEffect, useRef } from "react";

import { cn } from "~/lib/utils";

export type SlidingSegmentedControlOption<T extends string> = {
  value: T;
  label: string;
};

export function SlidingSegmentedControl<T extends string>({
  value,
  options,
  ariaLabel,
  className,
  optionClassName,
  onValueChange,
  pillClassName,
}: {
  value: T;
  options: readonly SlidingSegmentedControlOption<T>[];
  ariaLabel: string;
  className?: string;
  optionClassName?: string;
  onValueChange: (value: T) => void;
  pillClassName?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>());
  const pillPositionedRef = useRef(false);

  const movePill = useCallback((nextValue: T, animate: boolean) => {
    const pill = pillRef.current;
    const button = buttonRefs.current.get(nextValue);
    if (!pill || !button) return;

    if (!animate) {
      const previousTransition = pill.style.transition;
      pill.style.transition = "none";
      pill.style.transform = `translate3d(${button.offsetLeft}px, 0, 0)`;
      pill.style.width = `${button.offsetWidth}px`;
      void pill.offsetWidth;
      pill.style.transition = previousTransition;
      return;
    }

    pill.style.transform = `translate3d(${button.offsetLeft}px, 0, 0)`;
    pill.style.width = `${button.offsetWidth}px`;
  }, []);

  useLayoutEffect(() => {
    const shouldAnimate = pillPositionedRef.current;
    movePill(value, shouldAnimate);
    pillPositionedRef.current = true;
  }, [movePill, value]);

  useLayoutEffect(() => {
    const repositionWithoutAnimation = () => movePill(value, false);
    const root = rootRef.current;
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(repositionWithoutAnimation) : null;

    if (root) observer?.observe(root);
    for (const button of buttonRefs.current.values()) {
      observer?.observe(button);
    }
    window.addEventListener("resize", repositionWithoutAnimation);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", repositionWithoutAnimation);
    };
  }, [movePill, value]);

  return (
    <div
      ref={rootRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn("relative isolate grid rounded-lg bg-muted/45 p-0.5", className)}
      data-slot="sliding-segmented-control"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        ref={pillRef}
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-0.5 left-0 z-0 h-[calc(100%-0.25rem)] w-0 rounded-md bg-background shadow-sm transition-[transform,width] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          pillClassName,
        )}
        data-slot="sliding-segmented-pill"
      />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) {
                buttonRefs.current.set(option.value, node);
              } else {
                buttonRefs.current.delete(option.value);
              }
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
              "relative z-10 cursor-pointer rounded-md px-2 py-1.5 text-xs outline-none transition-colors duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              optionClassName,
            )}
            onClick={() => onValueChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export type SlidingSegmentedPanel<T extends string> = {
  value: T;
  ariaLabel: string;
  content: ReactNode;
};

export function SlidingSegmentedPanelGroup<T extends string>({
  value,
  panels,
  className,
}: {
  value: T;
  panels: readonly SlidingSegmentedPanel<T>[];
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRefs = useRef(new Map<T, HTMLElement>());
  const measuredRef = useRef(false);
  const panelSignature = panels.map((panel) => panel.value).join("\u0000");

  const measureActivePanel = useCallback(
    (animate: boolean) => {
      const root = rootRef.current;
      const panel = panelRefs.current.get(value);
      if (!root || !panel) return;

      const nextHeight = panel.offsetHeight;
      if (!animate) {
        const previousTransition = root.style.transition;
        root.style.transition = "none";
        root.style.height = `${nextHeight}px`;
        void root.offsetHeight;
        root.style.transition = previousTransition;
        return;
      }

      root.style.height = `${nextHeight}px`;
    },
    [value],
  );

  useLayoutEffect(() => {
    measureActivePanel(measuredRef.current);
    measuredRef.current = true;
  }, [measureActivePanel]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureActivePanel(measuredRef.current));
    for (const panel of panelRefs.current.values()) observer.observe(panel);
    return () => observer.disconnect();
  }, [measureActivePanel, panelSignature]);

  const activeIndex = panels.findIndex((panel) => panel.value === value);

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative h-0 overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        className,
      )}
      data-slot="sliding-segmented-panels"
    >
      {panels.map((panel, index) => {
        const active = panel.value === value;
        return (
          <section
            key={panel.value}
            ref={(node) => {
              if (node) {
                panelRefs.current.set(panel.value, node);
              } else {
                panelRefs.current.delete(panel.value);
              }
            }}
            aria-hidden={active ? undefined : true}
            aria-label={panel.ariaLabel}
            className={cn(
              "absolute inset-x-0 top-0 w-full transition-[opacity,transform,filter] duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              active
                ? "z-10 translate-x-0 opacity-100 blur-0"
                : cn(
                    "z-0 pointer-events-none opacity-0 blur-[3px]",
                    index < activeIndex ? "-translate-x-2" : "translate-x-2",
                  ),
            )}
            data-active={active ? "true" : "false"}
            inert={!active}
            role="tabpanel"
          >
            {panel.content}
          </section>
        );
      })}
    </div>
  );
}
