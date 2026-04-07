"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "~/lib/utils";

type InputProps = Omit<ComponentPropsWithoutRef<typeof InputPrimitive>, "size"> & {
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
  nativeInput?: boolean;
};

// Forward refs so the browser address bar can autofocus and select reliably.
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = "default", unstyled = false, nativeInput = false, ...props },
  ref,
) {
  const inputClassName = cn(
    "font-system-ui h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-muted-foreground/72 sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
    size === "sm" && "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
    size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
  );

  return (
    <span
      className={
        cn(
          !unstyled &&
            "relative inline-flex w-full rounded-md border border-input bg-background not-dark:bg-clip-padding text-base text-foreground ring-ring/16 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/2%)] has-focus-visible:has-aria-invalid:border-destructive/50 has-focus-visible:has-aria-invalid:ring-destructive/12 has-aria-invalid:border-destructive/30 has-focus-visible:border-ring/70 has-autofill:bg-foreground/4 has-disabled:opacity-64 has-focus-visible:ring-2 sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/3%)]",
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
          {...props}
        />
      ) : (
        <InputPrimitive
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          ref={ref}
          {...props}
        />
      )}
    </span>
  );
});

export { Input, type InputProps };
