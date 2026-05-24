// FILE: ComposerPickerMenuPopup.tsx
// Purpose: Shared menu popup shell for composer pickers (model, effort, traits, extras).
// Layer: Chat composer presentation
// Depends on: shared menu primitives and composer picker surface/width tokens.

import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { MenuPopup, MenuSubPopup } from "../ui/menu";
import { TooltipPopup } from "../ui/tooltip";
import {
  COMPOSER_PICKER_MENU_MIN_WIDTH_CLASS_NAME,
  COMPOSER_PICKER_TOOLTIP_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";

type ComposerPickerMenuPopupProps = Omit<ComponentProps<typeof MenuPopup>, "surface">;

/** Composer-attached menu popup with shared width, border, and shadow chrome. */
export function ComposerPickerMenuPopup({
  className,
  ...props
}: ComposerPickerMenuPopupProps) {
  return (
    <MenuPopup
      surface="composer"
      className={cn(COMPOSER_PICKER_MENU_MIN_WIDTH_CLASS_NAME, className)}
      {...props}
    />
  );
}

type ComposerPickerMenuSubPopupProps = Omit<ComponentProps<typeof MenuSubPopup>, "surface">;

/** Composer-attached submenu popup with the same shared shell styling. */
export function ComposerPickerMenuSubPopup({
  className,
  ...props
}: ComposerPickerMenuSubPopupProps) {
  return (
    <MenuSubPopup
      surface="composer"
      className={cn(COMPOSER_PICKER_MENU_MIN_WIDTH_CLASS_NAME, className)}
      {...props}
    />
  );
}

type ComposerPickerTooltipPopupProps = ComponentProps<typeof TooltipPopup>;

/** Composer-attached tooltip with the same border, shadow, and surface as picker menus. */
export function ComposerPickerTooltipPopup({
  className,
  ...props
}: ComposerPickerTooltipPopupProps) {
  return (
    <TooltipPopup
      className={cn(COMPOSER_PICKER_TOOLTIP_SURFACE_CLASS_NAME, className)}
      {...props}
    />
  );
}
