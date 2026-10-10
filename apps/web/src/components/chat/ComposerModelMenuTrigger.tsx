// FILE: ComposerModelMenuTrigger.tsx
// Purpose: The composer footer's "provider icon · model · effort" menu trigger, shared by
//   every picker that opens from it so label degradation and the shortcut tooltip stay identical.
// Layer: Chat composer presentation
// Depends on: menu/tooltip primitives, provider icons, and composer picker text tokens.

import type { ProviderKind } from "@synara/contracts";
import { useState } from "react";

import { ChevronDownIcon, FastModeIcon, SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ProviderAccountDot } from "../ProviderAccountMark";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { Button } from "../ui/button";
import { MenuTrigger } from "../ui/menu";
import { ShortcutKbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
} from "./composerPickerStyles";
import { getProviderIconClassName } from "./ProviderModelPicker";

// Must render inside a `Menu`. `hideModelLabel` / `hideStatusLabel` are the narrow-composer
// degradation steps: the text moves to title/sr-only so assistive tech keeps it.
export function ComposerModelMenuTrigger(props: {
  provider: ProviderKind;
  /** Set while the provider has several accounts, to tell which one the composer runs in. */
  accountLabel?: string | null | undefined;
  /** The account's own name, written before the model while the provider has several. */
  accountName?: string | null | undefined;
  accountAccentColor?: string | undefined;
  modelLabel: string;
  statusLabel: string | null;
  contextWindowLabel?: string | null | undefined;
  showsFastBadge: boolean;
  hideModelLabel?: boolean | undefined;
  hideStatusLabel?: boolean | undefined;
  disabled?: boolean | undefined;
  isMenuOpen: boolean;
  /** Laid over the model/effort text while the menu is open. The text underneath stays in
   *  place, invisible and frozen at its open-time value, so it keeps sizing the pill:
   *  tuning effort in the open panel cannot resize the trigger and drag the popup sideways. */
  openPlaceholderLabel?: string | null | undefined;
  shortcutLabel?: string | null | undefined;
}) {
  const freezesLabel = props.isMenuOpen && Boolean(props.openPlaceholderLabel);
  // A compact (icon-only) trigger has no room for the placeholder; it only freezes.
  const showsPlaceholder = freezesLabel && !props.hideModelLabel;
  // Opening must not move the trigger at all: Base UI opens on mousedown and cancels the
  // open when the matching mouseup lands outside the trigger, so a resize under the cursor
  // eats the first click.
  const liveLabel = {
    modelLabel: props.modelLabel,
    statusLabel: props.statusLabel,
    contextWindowLabel: props.contextWindowLabel,
    showsFastBadge: props.showsFastBadge,
  };
  const [frozenLabel, setFrozenLabel] = useState<typeof liveLabel | null>(null);
  if (freezesLabel && frozenLabel === null) setFrozenLabel(liveLabel);
  if (!freezesLabel && frozenLabel !== null) setFrozenLabel(null);
  const label = freezesLabel && frozenLabel !== null ? frozenLabel : liveLabel;
  // The label only plays its entry once it has actually been covered, never on mount.
  const [hasShownPlaceholder, setHasShownPlaceholder] = useState(false);
  if (showsPlaceholder && !hasShownPlaceholder) setHasShownPlaceholder(true);
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[props.provider];
  const hiddenTriggerTitle = [
    props.accountLabel,
    props.hideModelLabel ? props.modelLabel : null,
    props.hideStatusLabel ? props.statusLabel : null,
    props.hideStatusLabel ? props.contextWindowLabel : null,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");

  const triggerButton = (
    <Button
      size="sm"
      variant="chrome"
      disabled={props.disabled ?? false}
      className={cn(
        "min-w-0 shrink-0 justify-start gap-1.5 whitespace-nowrap px-2 sm:px-2.5 [&_svg]:mx-0",
        COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
      )}
      aria-label="Change model and reasoning"
      {...(hiddenTriggerTitle.length > 0 ? { title: hiddenTriggerTitle } : {})}
    />
  );

  const triggerContent = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="relative flex min-w-0 items-center">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 overflow-hidden",
            showsPlaceholder ? "invisible" : hasShownPlaceholder && "composer-trigger-label-enter",
          )}
        >
          <ProviderIcon
            aria-hidden="true"
            className={cn(
              // opacity-100 opts out of the Button base's [&_svg]:opacity-80 dimming.
              "size-3.5 shrink-0 opacity-100",
              getProviderIconClassName(props.provider, "text-[var(--color-text-foreground)]"),
            )}
          />
          <ProviderAccountDot
            accentColor={props.accountAccentColor}
            className="-ms-1 size-1.5 shrink-0 self-start ring-0"
          />
          {props.accountName ? (
            props.hideModelLabel ? (
              <span className="sr-only">{props.accountLabel}</span>
            ) : (
              <span
                className={cn("max-w-24 shrink-0 truncate", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
              >
                {props.accountName}
              </span>
            )
          ) : null}
          {props.hideModelLabel ? (
            <span className="sr-only">{label.modelLabel}</span>
          ) : (
            <span className="min-w-0 truncate text-[var(--color-text-foreground)]">
              {label.modelLabel}
            </span>
          )}
          {label.showsFastBadge ? (
            <FastModeIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-[var(--color-text-foreground)] opacity-100"
            />
          ) : null}
          {label.statusLabel ? (
            props.hideStatusLabel ? (
              <>
                <SettingsIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0 dark:text-muted-foreground/45",
                    COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
                  )}
                />
                <span className="sr-only">{label.statusLabel}</span>
              </>
            ) : (
              <span
                className={cn(
                  "shrink-0 dark:text-muted-foreground/45",
                  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
                )}
              >
                {label.statusLabel}
              </span>
            )
          ) : null}
          {label.contextWindowLabel ? (
            <span
              className={
                props.hideStatusLabel
                  ? "sr-only"
                  : cn("shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)
              }
            >
              {label.contextWindowLabel}
            </span>
          ) : null}
        </span>
        {showsPlaceholder ? (
          <span
            className={cn(
              "composer-trigger-label-enter absolute inset-0 truncate text-center",
              COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
            )}
          >
            {props.openPlaceholderLabel}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon aria-hidden="true" className="ms-0.5 size-3 shrink-0 opacity-60" />
    </span>
  );

  if (!props.shortcutLabel) {
    return <MenuTrigger render={triggerButton}>{triggerContent}</MenuTrigger>;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
        {triggerContent}
      </TooltipTrigger>
      {!props.isMenuOpen ? (
        <TooltipPopup side="top" sideOffset={6} variant="picker">
          <span className="inline-flex items-center gap-2 px-1 py-0.5">
            <span>Change model</span>
            <ShortcutKbd shortcutLabel={props.shortcutLabel} className="h-4 min-w-4 text-ui-2xs" />
          </span>
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}
