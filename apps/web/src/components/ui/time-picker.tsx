"use client";

import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Parse an "HH:MM" string into clamped hour/minute numbers (defaults to 00:00). */
function parseTime(value: string): { hour: number; minute: number } {
  const [rawHour, rawMinute] = value.split(":");
  const hour = Number.parseInt(rawHour ?? "", 10);
  const minute = Number.parseInt(rawMinute ?? "", 10);
  return {
    hour: Number.isNaN(hour) ? 0 : Math.min(23, Math.max(0, hour)),
    minute: Number.isNaN(minute) ? 0 : Math.min(59, Math.max(0, minute)),
  };
}

/**
 * shadcn-style scrollable time picker: two columns (hours / minutes) of selectable
 * values with the active one highlighted, mirroring the date-time picker blocks.
 * Emits an "HH:MM" string so it drops in wherever a native `<input type="time">` was.
 */
export function TimePicker({
  value,
  onChange,
  className,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly className?: string;
}) {
  const { hour, minute } = parseTime(value);
  return (
    <div className={cn("flex h-44 items-stretch gap-1", className)} data-slot="time-picker">
      <TimeColumn
        ariaLabel="Hour"
        selected={hour}
        values={HOURS}
        onSelect={(next) => onChange(`${pad(next)}:${pad(minute)}`)}
      />
      <div className="w-px shrink-0 self-stretch bg-border" />
      <TimeColumn
        ariaLabel="Minute"
        selected={minute}
        values={MINUTES}
        onSelect={(next) => onChange(`${pad(hour)}:${pad(next)}`)}
      />
    </div>
  );
}

function TimeColumn({
  ariaLabel,
  values,
  selected,
  onSelect,
}: {
  readonly ariaLabel: string;
  readonly values: readonly number[];
  readonly selected: number;
  readonly onSelect: (value: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  // Center the active value when the picker opens, scrolling only this column
  // (never the surrounding menu) so the selection is visible without a jump.
  useEffect(() => {
    const container = scrollRef.current;
    const item = selectedRef.current;
    if (!container || !item) return;
    container.scrollTop = item.offsetTop - container.clientHeight / 2 + item.clientHeight / 2;
  }, []);

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label={ariaLabel}
      className="relative min-w-0 flex-1 overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex flex-col gap-0.5 px-1 py-1">
        {values.map((entry) => {
          const isSelected = entry === selected;
          return (
            <Button
              key={entry}
              ref={isSelected ? selectedRef : undefined}
              size="sm"
              variant={isSelected ? "default" : "ghost"}
              role="option"
              aria-selected={isSelected}
              className="shrink-0 justify-center tabular-nums"
              onClick={() => onSelect(entry)}
            >
              {pad(entry)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
