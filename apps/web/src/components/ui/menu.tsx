"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ChevronRightIcon } from "~/lib/icons";
import type * as React from "react";

import { cn } from "~/lib/utils";
import {
  APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
  COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
  COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME,
} from "../chat/composerPickerStyles";
import { SWITCH_THUMB_CLASS_NAME, SWITCH_TRACK_CLASS_NAME } from "./switch";

const MenuCreateHandle = MenuPrimitive.createHandle;

const Menu = MenuPrimitive.Root;

const MenuPortal = MenuPrimitive.Portal;

function MenuTrigger({ className, children, ...props }: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </MenuPrimitive.Trigger>
  );
}

function MenuPopup({
  children,
  className,
  surface = "default",
  pickerSize,
  sideOffset = 4,
  align = "center",
  alignOffset,
  side = "bottom",
  anchor,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  surface?: "default" | "composer";
  pickerSize?: "small" | "normal" | undefined;
}) {
  const popupSurfaceClassName =
    surface === "composer"
      ? COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME
      : APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME;

  const isComposerSurface = surface === "composer";

  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className={cn("z-50 min-w-32", isComposerSurface ? undefined : className)}
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "relative flex origin-(--transform-origin) text-[var(--color-text-foreground)] outline-none focus:outline-none",
            isComposerSurface ? "min-w-0 max-w-[92vw]" : "w-full min-w-full",
            isComposerSurface ? className : null,
            popupSurfaceClassName,
          )}
          data-slot="menu-popup"
          {...props}
        >
          {surface === "composer" ? (
            <div
              className={cn(
                COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
                "relative z-1 max-h-(--available-height)",
              )}
              data-picker-size={pickerSize}
              data-slot="menu-popup-body"
            >
              {children}
            </div>
          ) : (
            <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
          )}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
        "data-inset:ps-8 data-[variant=destructive]:text-destructive-foreground",
        className,
      )}
      data-inset={inset}
      data-variant={variant}
      {...props}
      data-slot="menu-item"
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "switch";
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          "grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] py-1 ps-2",
        ),
        variant === "switch"
          ? "grid-cols-[1fr_auto] gap-4 pe-1.5"
          : "grid-cols-[1fr_auto] gap-3 px-2.5",
        className,
      )}
      {...props}
      data-slot="menu-checkbox-item"
    >
      {variant === "switch" ? (
        <>
          <span className="col-start-1">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator
            className={cn(
              SWITCH_TRACK_CLASS_NAME,
              "inset-shadow-[0_1px_--theme(--color-black/4%)] [--thumb-size:--spacing(4)] focus-visible:ring-1 sm:[--thumb-size:--spacing(3)]",
            )}
            keepMounted
          >
            <span
              className={cn(
                SWITCH_THUMB_CLASS_NAME,
                "in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[var(--thumb-size)_50%] in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[calc(var(--thumb-size)-4px)] in-[[data-slot=menu-checkbox-item]:active]:not-data-disabled:scale-x-110 in-[[data-slot=menu-checkbox-item]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.10)]",
              )}
            />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <span className="col-start-1 min-w-0">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator className="col-start-2 justify-self-end">
            <svg
              className="size-3"
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({
  className,
  children,
  preserveChildLayout = false,
  trailing,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  preserveChildLayout?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          preserveChildLayout
            ? "grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] grid-cols-[minmax(0,1fr)_2.5rem] gap-x-1.5 gap-y-0 px-2"
            : "w-full min-w-0 px-2.5",
        ),
        className,
      )}
      {...props}
      data-slot="menu-radio-item"
    >
      {preserveChildLayout ? (
        <>
          <span className="col-start-1 min-w-0">{children}</span>
          <div className="col-start-2 flex shrink-0 items-center justify-end gap-0.5">
            <MenuPrimitive.RadioItemIndicator className="shrink-0 data-unchecked:hidden">
              <svg
                className="size-3"
                fill="none"
                height="24"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                width="24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
              </svg>
            </MenuPrimitive.RadioItemIndicator>
            {trailing}
          </div>
        </>
      ) : (
        <span className="flex w-full min-w-0 items-center gap-2">
          {children}
          <MenuPrimitive.RadioItemIndicator className="ml-auto shrink-0">
            <svg
              className="size-3"
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
          </MenuPrimitive.RadioItemIndicator>
        </span>
      )}
    </MenuPrimitive.RadioItem>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      // Shared section/group label style: matches the composer picker section
      // headers (e.g. "Effort"). Picker menus may still override padding-block
      // via the `--picker-section-py` token on `[data-slot="menu-label"]`.
      className={cn(
        "px-2 py-1.5 font-normal text-xs text-muted-foreground/45 data-inset:ps-9 sm:data-inset:ps-8",
        className,
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-muted-foreground/72 text-[length:var(--app-font-size-ui-xs,10px)] tracking-widest",
        className,
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          "data-popup-open:bg-[var(--color-background-button-secondary-hover)] data-popup-open:text-[var(--color-text-foreground)] data-inset:ps-8",
        ),
        className,
      )}
      data-inset={inset}
      {...props}
      data-slot="menu-sub-trigger"
    >
      {children}
      <ChevronRightIcon className="-me-0.5 shrink-0" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  surface = "default",
  pickerSize,
  sideOffset = 0,
  alignOffset,
  align = "start",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  surface?: "default" | "composer";
  pickerSize?: "small" | "normal";
}) {
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      pickerSize={pickerSize}
      side="inline-end"
      sideOffset={sideOffset}
      surface={surface}
      {...props}
    />
  );
}

export {
  MenuCreateHandle,
  MenuCreateHandle as DropdownMenuCreateHandle,
  Menu,
  Menu as DropdownMenu,
  MenuPortal,
  MenuPortal as DropdownMenuPortal,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuItem,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
};
