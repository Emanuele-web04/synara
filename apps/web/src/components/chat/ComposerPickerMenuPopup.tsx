// FILE: ComposerPickerMenuPopup.tsx
// Purpose: Shared open-panel shell for picker menus (composer model/effort, handoff, git, etc.).
// Layer: App picker presentation
// Depends on: shared menu primitives and composer picker surface tokens in composerPickerStyles.

import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { MenuPopupBase, MenuSubPopup } from "../ui/menu";
import { SelectPopup } from "../ui/select";
import {
  type ComposerPickerSize,
  composerPickerMenuFixedShellClassName,
  composerPickerMenuShellClassName,
  resolveComposerPickerSize,
} from "./composerPickerSize";

type ComposerPickerMenuPopupProps = Omit<ComponentProps<typeof MenuPopupBase>, "surface"> & {
  /** Override global COMPOSER_PICKER_SIZE for this panel. */
  size?: ComposerPickerSize;
  /** Apply the fixed picker width (model/effort/provider pickers). Off = content-sized. */
  fixedWidth?: boolean;
};

/** App-wide picker dropdown panel — frosted shell, border, shadow, option row radius. */
export function ComposerPickerMenuPopup({
  className,
  size,
  fixedWidth = false,
  ...props
}: ComposerPickerMenuPopupProps) {
  const resolvedSize = resolveComposerPickerSize(size);
  return (
    <MenuPopupBase
      surface="composer"
      pickerSize={resolvedSize}
      className={cn(
        fixedWidth
          ? composerPickerMenuFixedShellClassName(resolvedSize)
          : composerPickerMenuShellClassName(resolvedSize),
        className,
      )}
      {...props}
    />
  );
}

/** Alias for menus outside the composer footer that share the same open panel chrome. */
export const PickerMenuPopup = ComposerPickerMenuPopup;

type ComposerPickerSelectPopupProps = Omit<ComponentProps<typeof SelectPopup>, "surface"> & {
  size?: ComposerPickerSize;
};

/** Select dropdown panel with the same frosted shell and option rows as picker menus. */
export function ComposerPickerSelectPopup({
  align = "end",
  alignItemWithTrigger = false,
  size,
  className,
  ...props
}: ComposerPickerSelectPopupProps) {
  const resolvedSize = resolveComposerPickerSize(size);
  return (
    <SelectPopup
      align={align}
      alignItemWithTrigger={alignItemWithTrigger}
      surface="composer"
      shellClassName={composerPickerMenuShellClassName(resolvedSize)}
      className={className}
      {...props}
    />
  );
}

/** Alias for settings and other non-menu pickers that open a select list panel. */
export const PickerSelectPopup = ComposerPickerSelectPopup;

type ComposerPickerMenuSubPopupProps = Omit<ComponentProps<typeof MenuSubPopup>, "surface"> & {
  /** Override global COMPOSER_PICKER_SIZE for this submenu. */
  size?: ComposerPickerSize;
  /** Apply the fixed picker width (model/effort/provider pickers). Off = content-sized. */
  fixedWidth?: boolean;
};

/** Composer-attached submenu popup with the same shared shell styling. */
export function ComposerPickerMenuSubPopup({
  className,
  size,
  fixedWidth = false,
  ...props
}: ComposerPickerMenuSubPopupProps) {
  const resolvedSize = resolveComposerPickerSize(size);
  return (
    <MenuSubPopup
      surface="composer"
      pickerSize={resolvedSize}
      className={cn(
        fixedWidth
          ? composerPickerMenuFixedShellClassName(resolvedSize)
          : composerPickerMenuShellClassName(resolvedSize),
        className,
      )}
      {...props}
    />
  );
}
