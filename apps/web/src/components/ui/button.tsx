"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-[length:var(--app-font-size-ui,12px)] outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 sm:text-[length:var(--app-font-size-ui,12px)] [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 rounded-sm before:rounded-[calc(var(--radius-sm)-1px)] sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-[length:var(--app-font-size-ui-lg,13px)] sm:h-10 sm:text-[length:var(--app-font-size-ui-lg,13px)] [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 rounded-sm px-[calc(--spacing(2)-1px)] text-[length:var(--app-font-size-ui-sm,11px)] before:rounded-[calc(var(--radius-sm)-1px)] sm:h-6 sm:text-[length:var(--app-font-size-ui-xs,10px)] [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        chrome:
          "border-transparent bg-transparent text-[var(--color-text-foreground-secondary)] shadow-none focus-visible:ring-[color:var(--color-border-focus)]/60 focus-visible:ring-offset-0 [:hover,[data-pressed]]:bg-[var(--color-background-button-secondary-hover)] [:hover,[data-pressed]]:text-[var(--color-text-foreground)] data-pressed:bg-[var(--color-background-button-secondary)] data-pressed:text-[var(--color-text-foreground)]",
        default:
          "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-primary/90",
        destructive:
          "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-destructive/90",
        "destructive-outline":
          "border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] not-dark:bg-clip-padding text-destructive-foreground not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/2%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/1%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/3%)] [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4",
        ghost:
          "border-transparent bg-transparent text-[var(--color-text-foreground-secondary)] shadow-none focus-visible:ring-[color:var(--color-border-focus)]/60 focus-visible:ring-offset-0 [:hover,[data-pressed]]:bg-[var(--color-background-button-secondary-hover)] [:hover,[data-pressed]]:text-[var(--color-text-foreground)] data-pressed:bg-[var(--color-background-button-secondary)] data-pressed:text-[var(--color-text-foreground)]",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        outline:
          "border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/2%)] focus-visible:ring-[color:var(--color-border-focus)]/60 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/3%)] [:hover,[data-pressed]]:bg-[var(--color-background-elevated-secondary)] dark:[:hover,[data-pressed]]:bg-[var(--color-background-elevated-secondary)]",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
      },
    },
  },
);

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { Button, buttonVariants };
