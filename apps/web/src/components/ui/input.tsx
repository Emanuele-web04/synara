"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "~/lib/utils";

type InputProps = Omit<ComponentPropsWithoutRef<typeof InputPrimitive>, "size"> & {
  size?: "sm" | "default" | "lg" | number;
  // "soft" gives the field a faint filled background instead of the default
  // surface-matching fill, so it reads as an input even on a flush card.
  variant?: "default" | "soft";
  unstyled?: boolean;
  nativeInput?: boolean;
};

// Forward refs so the browser address bar can autofocus and select reliably.
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    size = "default",
    variant = "default",
    unstyled = false,
    nativeInput = false,
    style,
    ...props
  },
  ref,
) {
  const inputClassName = cn(
    "font-system-ui h-full w-full min-w-0 rounded-[inherit] border-0 bg-transparent px-3 py-1.5 text-[length:var(--app-font-size-ui,12px)] leading-normal outline-none placeholder:text-muted-foreground/72 [transition:background-color_5000000s_ease-in-out_0s] sm:text-[length:var(--app-font-size-ui,12px)]",
    size === "sm" &&
      "px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)]",
    size === "lg" && "px-3.5 py-2",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-[length:var(--app-font-size-ui-sm,11px)] file:text-foreground",
  );

  return (
    <span
      className={
        cn(
          !unstyled &&
            "relative inline-flex w-full min-h-9 items-center rounded-lg border border-border bg-background text-[length:var(--app-font-size-ui,12px)] text-foreground has-aria-invalid:border-destructive/30 has-focus-visible:has-aria-invalid:border-destructive/50 has-focus-visible:border-foreground/30 has-autofill:bg-foreground/4 has-disabled:opacity-64 sm:min-h-8 sm:text-[length:var(--app-font-size-ui,12px)] dark:bg-input/32 dark:has-autofill:bg-foreground/8",
          size === "sm" && "min-h-8 sm:min-h-7",
          size === "lg" && "min-h-10 sm:min-h-9",
          variant === "soft" && "bg-foreground/2 dark:bg-foreground/2",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {nativeInput ? (
        <input
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          ref={ref}
          style={typeof style === "function" ? undefined : style}
          {...props}
        />
      ) : (
        <InputPrimitive
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          ref={ref}
          style={style}
          {...props}
        />
      )}
    </span>
  );
});

export { Input, type InputProps };
