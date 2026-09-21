"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils";
import { extendButtonIconChildSelectors } from "~/lib/central-icons";

/** Slightly softer outline border for header chrome buttons in dark mode. */
const headerButtonDarkBorderClassName =
  "dark:border-[color:color-mix(in_srgb,var(--color-border)_80%,transparent)]";

// variant taxonomy: text sizes pair with square icon-only counterparts at matching heights; visual style intentionally flat — add a variant rather than shadows or call-site overrides
const buttonVariants = cva(
  extendButtonIconChildSelectors(
    "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-ui outline-none pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 sm:text-ui [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  ),
  {
    defaultVariants: {
      shape: "default",
      size: "default",
      variant: "default",
    },
    variants: {
      shape: {
        capsule: "rounded-full font-normal",
        default: "",
      },
      size: {
        chip: extendButtonIconChildSelectors(
          "h-auto gap-1 px-2 py-0.5 text-ui-sm sm:h-auto sm:text-ui-sm [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        ),
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-chip": extendButtonIconChildSelectors(
          "size-6 sm:size-6 [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        ),
        "icon-lg": "size-10 sm:size-9",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl": extendButtonIconChildSelectors(
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        ),
        "icon-xs": extendButtonIconChildSelectors(
          "size-7 rounded-sm sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        ),
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        xl: extendButtonIconChildSelectors(
          "h-11 px-[calc(--spacing(4)-1px)] text-ui-lg sm:h-10 sm:text-ui-lg [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        ),
        xs: extendButtonIconChildSelectors(
          "h-7 gap-1 rounded-sm px-[calc(--spacing(2)-1px)] text-ui-sm sm:h-6 sm:text-ui-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
        ),
      },
      variant: {
        chrome:
          "border-transparent bg-transparent text-[var(--color-text-foreground-secondary)] focus-visible:ring-[color:var(--color-border-focus)]/60 focus-visible:ring-offset-0 [:hover,[data-pressed]]:bg-[var(--color-background-elevated-secondary)] [:hover,[data-pressed]]:text-[var(--color-text-foreground)] data-pressed:bg-[var(--color-background-elevated-secondary)] data-pressed:text-[var(--color-text-foreground)]",
        "chrome-outline": extendButtonIconChildSelectors(
          `border-[color:var(--color-border)] bg-transparent text-[var(--color-text-foreground)] focus-visible:ring-[color:var(--color-border-focus)]/60 [:hover,[data-pressed]]:bg-secondary ${headerButtonDarkBorderClassName} dark:[:hover,[data-pressed]]:bg-secondary [&_svg]:mx-0`,
        ),
        default:
          "border-transparent bg-primary text-primary-foreground [:hover,[data-pressed]]:bg-primary/90",
        destructive:
          "border-destructive bg-destructive text-white [:hover,[data-pressed]]:bg-destructive/90",
        "destructive-outline":
          "border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-destructive [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4 [:hover,[data-pressed]]:text-destructive",
        ghost:
          "border-transparent bg-transparent text-[var(--color-text-foreground-secondary)] focus-visible:ring-[color:var(--color-border-focus)]/60 focus-visible:ring-offset-0 [:hover,[data-pressed]]:bg-[var(--color-background-button-secondary-hover)] [:hover,[data-pressed]]:text-[var(--color-text-foreground)] data-pressed:bg-[var(--color-background-button-secondary)] data-pressed:text-[var(--color-text-foreground)]",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        outline:
          "border-[color:var(--color-border)] bg-transparent text-[var(--color-text-foreground)] focus-visible:ring-[color:var(--color-border-focus)]/60 [:hover,[data-pressed]]:bg-[var(--color-background-elevated-secondary)] dark:[:hover,[data-pressed]]:bg-[var(--color-background-elevated-secondary)]",
        "primary-outline":
          "border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-primary [:hover,[data-pressed]]:border-primary/32 [:hover,[data-pressed]]:bg-primary/4",
        prominent:
          "rounded-full border-transparent bg-[var(--color-text-foreground)] text-[var(--color-background-surface)] transition-[transform,opacity] duration-150 hover:scale-105 disabled:opacity-20 disabled:hover:scale-100",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
        "secondary-outline":
          "border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] [:hover,[data-pressed]]:bg-secondary/12",
        subtle:
          "border-transparent bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)] focus-visible:ring-[color:var(--color-border-focus)]/60 focus-visible:ring-offset-0 [:hover,[data-pressed]]:bg-[var(--color-background-button-secondary-hover)]",
      },
    },
    compoundVariants: [
      {
        class:
          "!box-border !h-auto !min-h-7 gap-1.5 rounded-lg px-[calc(--spacing(2.5)-1px)] !py-0.5 text-ui sm:!h-auto sm:px-[calc(--spacing(2.5)-1px)] sm:text-ui-sm",
        size: "xs",
        variant: "chrome-outline",
      },
      {
        class: "!size-8 rounded-lg sm:!size-7",
        size: "icon-xs",
        variant: "chrome-outline",
      },
    ],
  },
);

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  shape?: VariantProps<typeof buttonVariants>["shape"];
}

// `ref` rides along in props: React 19 passes it as a plain prop, and pulling it into a local made React Compiler read the component as a ref access during render and skip memoization
function Button({ className, variant, size, shape, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, shape, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

/** Dialog footers and inline error actions share this sizing override. */
const dialogActionButtonClassName =
  "!h-auto !min-h-8 !rounded-md !px-3 !py-1 !font-normal sm:!min-h-7";

export { Button, buttonVariants, dialogActionButtonClassName, headerButtonDarkBorderClassName };
