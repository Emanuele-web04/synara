// FILE: ThemeGallery.tsx
// Purpose: Gallery of complete built-in appearance presets.
// Layer: Settings UI components
// Exports: ThemeGallery

import { type CSSProperties } from "react";

import {
  buildThemeCssVariables,
  CODE_THEME_OPTIONS,
  getCodeThemeSeed,
  type ThemeVariant,
} from "~/theme/theme.logic";
import { useTheme } from "~/hooks/useTheme";
import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { cn } from "~/lib/utils";

function ThemePreview({ codeThemeId, variant }: { codeThemeId: string; variant: ThemeVariant }) {
  const theme = getCodeThemeSeed(codeThemeId, variant);
  const variables = buildThemeCssVariables({ codeThemeId, theme }, variant, {
    windowTranslucency: null,
  }).variables;

  return (
    <div
      aria-hidden
      className="relative aspect-[10/7] overflow-hidden rounded-lg border"
      style={
        {
          ...variables,
          backgroundColor: "var(--color-background-surface-under)",
          borderColor: "var(--color-border)",
          color: "var(--color-text-foreground)",
        } as CSSProperties
      }
    >
      <div
        className="absolute inset-x-[9%] top-[14%] bottom-0 rounded-t-md"
        style={{ backgroundColor: "var(--color-background-surface)" }}
      >
        <div className="flex flex-col items-center gap-1.5 pt-[9%]">
          <span
            className="h-1 w-[38%] rounded-full"
            style={{ backgroundColor: "var(--color-text-foreground-secondary)" }}
          />
          <span
            className="h-0.5 w-[55%] rounded-full"
            style={{ backgroundColor: "var(--color-border)" }}
          />
        </div>
        <div
          className="mx-[9%] mt-[7%] h-[62%] rounded-t-md p-[10%]"
          style={{ backgroundColor: "var(--color-background-panel)" }}
        >
          <div className="space-y-3">
            {[0, 1, 2].map((row) => (
              <div key={row}>
                <div
                  className="h-1 w-[36%] rounded-full"
                  style={{ backgroundColor: "var(--color-text-foreground-secondary)" }}
                />
                <div
                  className="mt-3 h-px w-full"
                  style={{ backgroundColor: "var(--color-border-light)" }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ThemeGallery({ variant }: { variant: ThemeVariant }) {
  const { themeState, setThemeFamily } = useTheme();
  const activeThemeId = themeState.codeThemeIds[variant];
  const options = CODE_THEME_OPTIONS.filter((option) => option.variants.includes(variant));
  const radioItemProps = useRadioGroupKeyboardNav({
    values: options.map((option) => option.id),
    value: activeThemeId,
    onValueChange: setThemeFamily,
  });

  return (
    <div
      role="radiogroup"
      aria-label={`${variant} theme presets`}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
    >
      {options.map((option) => {
        const isActive = option.id === activeThemeId;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={option.label}
            className={cn(
              "group flex min-w-0 flex-col gap-1.5 rounded-[14px] text-left outline-none",
              "focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
            onClick={() => setThemeFamily(option.id)}
            {...radioItemProps(option.id)}
          >
            <div
              className={cn(
                "w-full rounded-[14px] border-2 p-[3px] transition-colors motion-reduce:transition-none",
                isActive
                  ? "border-foreground"
                  : "border-transparent group-hover:border-foreground/25",
              )}
            >
              <ThemePreview codeThemeId={option.id} variant={variant} />
            </div>
            <span
              className={cn(
                "truncate px-1 text-ui leading-snug transition-colors motion-reduce:transition-none",
                isActive ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
