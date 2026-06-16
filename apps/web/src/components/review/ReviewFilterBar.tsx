import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { useMemo } from "react";

import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { CountChip } from "./reviewPrimitives";
import {
  type ActiveReviewFilter,
  type ReviewFilterDefinition,
  type ReviewSortOption,
  hasActiveReviewFilters,
} from "./reviewFilters";

const EMPTY_VALUES: ReadonlySet<string> = new Set();

function valuesFor(
  activeFilters: ReadonlyArray<ActiveReviewFilter>,
  fieldId: string,
): ReadonlySet<string> {
  return activeFilters.find((filter) => filter.fieldId === fieldId)?.values ?? EMPTY_VALUES;
}

function toggleValue(
  activeFilters: ReadonlyArray<ActiveReviewFilter>,
  fieldId: string,
  value: string,
): ActiveReviewFilter[] {
  const existing = activeFilters.find((filter) => filter.fieldId === fieldId);
  const nextValues = new Set(existing?.values ?? []);
  if (nextValues.has(value)) {
    nextValues.delete(value);
  } else {
    nextValues.add(value);
  }
  const others = activeFilters.filter((filter) => filter.fieldId !== fieldId);
  return nextValues.size > 0 ? [...others, { fieldId, values: nextValues }] : others;
}

function referenceLabel(reference: string): string {
  const numberMatch = /(?:\/pull\/|^#?)(\d+)(?:[/?#].*)?$/i.exec(reference.trim());
  return numberMatch?.[1] ? `#${numberMatch[1]}` : "PR";
}

function FacetChip(props: {
  def: ReviewFilterDefinition;
  items: ReadonlyArray<ReviewPullRequestSummary>;
  activeFilters: ReadonlyArray<ActiveReviewFilter>;
  onChange: (next: ActiveReviewFilter[]) => void;
}) {
  const options = useMemo(() => props.def.extractOptions(props.items), [props.def, props.items]);
  const selected = valuesFor(props.activeFilters, props.def.id);

  if (options.length === 0) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className={cn(
              "h-8 shrink-0 rounded-full px-3 text-[12px] text-muted-foreground",
              "bg-background/55 ring-1 ring-border/55 transition-[background-color,color,border-color] hover:bg-background/90 hover:text-foreground",
              selected.size > 0 && "bg-primary/10 text-foreground ring-primary/35",
            )}
          />
        }
      >
        {props.def.label}
        {selected.size > 0 ? <CountChip count={selected.size} /> : null}
        <ChevronDownIcon className="size-3 opacity-70" />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" sideOffset={8} className="w-56 rounded-2xl p-1.5">
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {options.map((option) => {
            const isOn = selected.has(option.value);
            return (
              <li key={option.value}>
                <button
                  type="button"
                  onClick={() =>
                    props.onChange(toggleValue(props.activeFilters, props.def.id, option.value))
                  }
                  className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[12px] text-foreground outline-none transition-colors hover:bg-[var(--sidebar-accent)] focus-visible:bg-[var(--sidebar-accent)]"
                >
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                      isOn ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {isOn ? <CheckIcon className="size-2.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}

export function ReviewFilterBar(props: {
  items: ReadonlyArray<ReviewPullRequestSummary>;
  defs: ReadonlyArray<ReviewFilterDefinition>;
  search: string;
  onSearchChange: (value: string) => void;
  activeFilters: ReadonlyArray<ActiveReviewFilter>;
  onActiveFiltersChange: (next: ActiveReviewFilter[]) => void;
  resultCount?: number;
  resultCountIsIncomplete?: boolean;
  sortOptions?: ReadonlyArray<ReviewSortOption>;
  sortId?: string;
  onSortChange?: (id: string) => void;
  onOpenReference?: (reference: string) => void;
  className?: string;
  searchClassName?: string;
}) {
  const showClear = hasActiveReviewFilters(props.activeFilters) || props.search.trim().length > 0;
  const sortLabel = props.sortOptions?.find((option) => option.id === props.sortId)?.label;
  const resultCount = props.resultCount ?? props.items.length;
  const resultCountLabel = `${String(resultCount)}${props.resultCountIsIncomplete ? "+" : ""}`;
  const resultCountTitle = props.resultCountIsIncomplete
    ? "GitHub returned the maximum fetched pull requests, so more matches may exist."
    : undefined;
  const parsedReference = parsePullRequestReference(props.search);
  const canOpenReference = parsedReference !== null && props.onOpenReference !== undefined;

  return (
    <div className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-1.5", props.className)}>
      <div
        className={cn("relative min-w-56 max-w-2xl flex-1 basis-[28rem]", props.searchClassName)}
      >
        <SearchIcon className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-3.5 text-muted-foreground/70" />
        <Input
          size="sm"
          type="search"
          className="h-8 rounded-full border-border/65 bg-background/72 ps-8 text-[12px] shadow-none transition-[background-color,border-color] placeholder:text-muted-foreground/62 focus-visible:bg-background focus-visible:shadow-none"
          placeholder="Search PRs, #7870, or a GitHub URL"
          value={props.search}
          onChange={(event) => props.onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !parsedReference || !props.onOpenReference) {
              return;
            }
            event.preventDefault();
            props.onOpenReference(parsedReference);
          }}
        />
      </div>

      {canOpenReference ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-8 shrink-0 rounded-full bg-background/72 px-3 text-[12px] shadow-none"
          onClick={() => props.onOpenReference?.(parsedReference)}
        >
          Open {referenceLabel(parsedReference)}
        </Button>
      ) : null}

      {props.defs.map((def) => (
        <FacetChip
          key={def.id}
          def={def}
          items={props.items}
          activeFilters={props.activeFilters}
          onChange={props.onActiveFiltersChange}
        />
      ))}

      {props.sortOptions && props.sortOptions.length > 0 && props.onSortChange ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-8 shrink-0 rounded-full bg-background/55 px-3 text-[12px] text-muted-foreground ring-1 ring-border/55 transition-[background-color,color] hover:bg-background/90 hover:text-foreground"
              />
            }
          >
            Sort{sortLabel ? <span className="text-muted-foreground">: {sortLabel}</span> : null}
            <ChevronDownIcon className="size-3 opacity-70" />
          </PopoverTrigger>
          <PopoverPopup
            align="start"
            side="bottom"
            sideOffset={8}
            className="w-52 rounded-2xl p-1.5"
          >
            <ul className="flex flex-col gap-0.5">
              {props.sortOptions.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => props.onSortChange?.(option.id)}
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[12px] text-foreground outline-none transition-colors hover:bg-[var(--sidebar-accent)] focus-visible:bg-[var(--sidebar-accent)]"
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.id === props.sortId ? (
                      <CheckIcon className="size-3 shrink-0 text-foreground" />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </PopoverPopup>
        </Popover>
      ) : null}

      <span
        className="hidden h-8 shrink-0 items-center rounded-full bg-muted/28 px-2.5 text-[11px] font-medium text-muted-foreground tabular-nums ring-1 ring-border/40 sm:inline-flex"
        title={resultCountTitle}
        aria-label={
          props.resultCountIsIncomplete
            ? `${resultCountLabel} pull requests; more matches may exist`
            : undefined
        }
      >
        {resultCountLabel} PR{resultCount === 1 && !props.resultCountIsIncomplete ? "" : "s"}
      </span>

      {showClear ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-8 shrink-0 rounded-full px-2.5 text-muted-foreground hover:text-foreground"
          onClick={() => {
            props.onActiveFiltersChange([]);
            props.onSearchChange("");
          }}
        >
          <XIcon className="size-3" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
