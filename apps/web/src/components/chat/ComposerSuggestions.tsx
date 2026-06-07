// FILE: ComposerSuggestions.tsx
// Purpose: Renders empty-chat prompt suggestions as horizontally aligned cards below the composer.
// Layer: Chat composer presentation
// Depends on: composerSuggestions helper.

import { memo } from "react";
import type { ComposerSuggestion } from "../../lib/composerSuggestions";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerSuggestionsProps {
  suggestions: readonly ComposerSuggestion[];
  className?: string | undefined;
  onSelectSuggestion: (suggestion: ComposerSuggestion) => void;
}

const SUGGESTION_LIST_CLASS_NAME = "grid w-full min-w-0 grid-cols-1 gap-2 sm:grid-cols-3";
const SUGGESTION_ITEM_CLASS_NAME = "flex min-w-0";
const SUGGESTION_ROW_CLASS_NAME =
  "group flex h-full w-full min-w-0 flex-col gap-1 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] px-3 py-2.5 text-left outline-none transition-colors hover:border-[color:var(--color-border-heavy)] hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:border-[color:var(--color-border-heavy)] focus-visible:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-heavy)]";
const SUGGESTION_TITLE_CLASS_NAME =
  "block w-full min-w-0 line-clamp-2 text-[length:var(--app-font-size-ui-sm,11px)] font-medium leading-normal text-[var(--color-text-foreground)]";
const SUGGESTION_DESCRIPTION_CLASS_NAME =
  "block w-full min-w-0 line-clamp-2 text-[length:var(--app-font-size-ui-xs,10px)] leading-normal text-[var(--color-text-foreground-secondary)] opacity-80";

function suggestionPromptFirstLine(suggestion: ComposerSuggestion): string {
  const firstLine = suggestion.prompt.split("\n").find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? "";
}

function ComposerSuggestionCard(props: {
  suggestion: ComposerSuggestion;
  onSelectSuggestion: (suggestion: ComposerSuggestion) => void;
}) {
  const { suggestion, onSelectSuggestion } = props;

  return (
    <Tooltip>
      <TooltipTrigger
        className="flex w-full min-w-0"
        render={
          <button
            type="button"
            className={SUGGESTION_ROW_CLASS_NAME}
            onClick={() => onSelectSuggestion(suggestion)}
          >
            <span className={SUGGESTION_TITLE_CLASS_NAME}>{suggestion.label}</span>
            <span className={SUGGESTION_DESCRIPTION_CLASS_NAME}>
              {suggestionPromptFirstLine(suggestion)}
            </span>
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {suggestion.prompt}
      </TooltipPopup>
    </Tooltip>
  );
}

export const ComposerSuggestions = memo(function ComposerSuggestions({
  suggestions,
  className,
  onSelectSuggestion,
}: ComposerSuggestionsProps) {
  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className={cn(SUGGESTION_LIST_CLASS_NAME, className)} data-testid="composer-suggestions">
      {suggestions.map((suggestion) => (
        <div key={suggestion.id} className={SUGGESTION_ITEM_CLASS_NAME}>
          <ComposerSuggestionCard suggestion={suggestion} onSelectSuggestion={onSelectSuggestion} />
        </div>
      ))}
    </div>
  );
});
