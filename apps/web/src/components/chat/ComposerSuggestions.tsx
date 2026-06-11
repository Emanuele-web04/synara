// FILE: ComposerSuggestions.tsx
// Purpose: Renders empty-chat prompt suggestions as compact single-line rows below the composer.
// Layer: Chat composer presentation
// Depends on: composerSuggestions helper and Central icon assets.

import { memo } from "react";
import type { ComposerSuggestion } from "../../lib/composerSuggestions";
import { CentralIcon } from "../../lib/central-icons";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerSuggestionsProps {
  suggestions: readonly ComposerSuggestion[];
  className?: string | undefined;
  onSelectSuggestion: (suggestion: ComposerSuggestion) => void;
}

const SUGGESTION_ICONS = ["reading-list", "brain", "fork-code", "rocket", "flag-1"] as const;
const SUGGESTION_LIST_CLASS_NAME = "flex w-full min-w-0 flex-col";
const SUGGESTION_ITEM_CLASS_NAME = "w-full min-w-0";
const SUGGESTION_ROW_CLASS_NAME =
  "group flex w-full min-w-0 items-start gap-2 rounded-lg bg-transparent px-2.5 py-2 text-left outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-heavy)]";
const SUGGESTION_DIVIDER_CLASS_NAME = "mx-2.5 border-b border-[color:var(--color-border-light)]";
const SUGGESTION_ICON_CLASS_NAME =
  "mt-px size-3 shrink-0 text-[var(--color-text-foreground-secondary)] opacity-80 transition-opacity group-hover:opacity-100";
const SUGGESTION_TEXT_CLASS_NAME = "flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden";
const SUGGESTION_TITLE_CLASS_NAME =
  "block w-full min-w-0 truncate text-[length:var(--app-font-size-ui-sm,11px)] font-medium leading-normal text-[var(--color-text-foreground)]";
const SUGGESTION_DESCRIPTION_CLASS_NAME =
  "block w-full min-w-0 truncate text-[length:var(--app-font-size-ui-xs,10px)] leading-normal text-[var(--color-text-foreground-secondary)] opacity-80";

function suggestionPromptFirstLine(suggestion: ComposerSuggestion): string {
  const firstLine = suggestion.prompt.split("\n").find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? "";
}

function ComposerSuggestionCard(props: {
  suggestion: ComposerSuggestion;
  iconName: (typeof SUGGESTION_ICONS)[number];
  onSelectSuggestion: (suggestion: ComposerSuggestion) => void;
}) {
  const { suggestion, iconName, onSelectSuggestion } = props;
  const promptLine = suggestionPromptFirstLine(suggestion);

  return (
    <Tooltip>
      <TooltipTrigger
        className="flex w-full min-w-0"
        render={
          <button
            type="button"
            className={SUGGESTION_ROW_CLASS_NAME}
            aria-label={`${suggestion.label}. ${promptLine}`}
            onClick={() => onSelectSuggestion(suggestion)}
          >
            <CentralIcon name={iconName} className={SUGGESTION_ICON_CLASS_NAME} />
            <span className={SUGGESTION_TEXT_CLASS_NAME}>
              <span className={SUGGESTION_TITLE_CLASS_NAME}>{suggestion.label}</span>
              <span className={SUGGESTION_DESCRIPTION_CLASS_NAME}>{promptLine}</span>
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
      {suggestions.map((suggestion, index) => {
        const iconName = SUGGESTION_ICONS[index % SUGGESTION_ICONS.length] ?? "reading-list";
        const isLast = index === suggestions.length - 1;

        return (
          <div key={suggestion.id} className={SUGGESTION_ITEM_CLASS_NAME}>
            <ComposerSuggestionCard
              suggestion={suggestion}
              iconName={iconName}
              onSelectSuggestion={onSelectSuggestion}
            />
            {isLast ? null : <div aria-hidden="true" className={SUGGESTION_DIVIDER_CLASS_NAME} />}
          </div>
        );
      })}
    </div>
  );
});
