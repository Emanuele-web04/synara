// FILE: ComposerModelMenuTrigger.tsx
// Purpose: The composer footer's "provider icon · model · effort" menu trigger, shared by
//   every picker that opens from it so label degradation and the shortcut tooltip stay identical.
// Layer: Chat composer presentation
// Depends on: menu/tooltip primitives, provider icons, and composer picker text tokens.

import type { ProviderKind } from "@synara/contracts";
import { useState } from "react";

import { ChevronDownIcon, FastModeIcon, SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { Button } from "../ui/button";
import { MenuTrigger } from "../ui/menu";
import { ShortcutKbd } from "../ui/shortcut-kbd";
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
  modelLabel: string;
  statusLabel: string | null;
  contextWindowLabel?: string | null | undefined;
  showsFastBadge: boolean;
  hideModelLabel?: boolean | undefined;
  hideStatusLabel?: boolean | undefined;
  disabled?: boolean | undefined;
  isMenuOpen: boolean;
  /** Shown instead of the model/effort text while the menu is open. The pill holds a fixed
   *  width for it, so tuning effort in the open panel cannot resize the trigger and drag
   *  the anchored popup sideways. */
  openPlaceholderLabel?: string | null | undefined;
  shortcutLabel?: string | null | undefined;
}) {
  const showsPlaceholder = props.isMenuOpen && Boolean(props.openPlaceholderLabel);
  // The label only plays its entry once it has actually been swapped out, never on mount.
  const [hasShownPlaceholder, setHasShownPlaceholder] = useState(false);
  if (showsPlaceholder && !hasShownPlaceholder) setHasShownPlaceholder(true);
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[props.provider];
  const hiddenTriggerTitle = [
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
        // Snap to the fixed width on open (the popup positions against it), ease back to
        // the label's own width on close where `interpolate-size` is supported.
        showsPlaceholder
          ? "w-36"
          : "[interpolate-size:allow-keywords] transition-[width] duration-200 ease-out motion-reduce:transition-none",
        COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
      )}
      aria-label="Change model and reasoning"
      {...(hiddenTriggerTitle.length > 0 ? { title: hiddenTriggerTitle } : {})}
    />
  );

  const triggerContent = showsPlaceholder ? (
    <span className="flex w-full min-w-0 items-center gap-1.5">
      <span
        className={cn("min-w-0 flex-1 truncate text-center", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
      >
        {props.openPlaceholderLabel}
      </span>
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </span>
  ) : (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-hidden",
        hasShownPlaceholder && "composer-trigger-label-enter",
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
      {props.hideModelLabel ? (
        <span className="sr-only">{props.modelLabel}</span>
      ) : (
        <span className="min-w-0 truncate text-[var(--color-text-foreground)]">
          {props.modelLabel}
        </span>
      )}
      {props.showsFastBadge ? (
        <FastModeIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
        />
      ) : null}
      {props.statusLabel ? (
        props.hideStatusLabel ? (
          <>
            <SettingsIcon
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
            />
            <span className="sr-only">{props.statusLabel}</span>
          </>
        ) : (
          <span className={cn("shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}>
            {props.statusLabel}
          </span>
        )
      ) : null}
      {props.contextWindowLabel ? (
        <span
          className={
            props.hideStatusLabel
              ? "sr-only"
              : cn("shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)
          }
        >
          {props.contextWindowLabel}
        </span>
      ) : null}
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
            <ShortcutKbd
              shortcutLabel={props.shortcutLabel}
              className="h-4 min-w-4 px-1 text-ui-2xs text-muted-foreground"
            />
          </span>
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}
