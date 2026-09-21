// a class helper not a wrapper component on purpose — CTAs are variously Link/a/button, so the call site keeps ownership of element, href, rel, and aria

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const ctaButton = cva(
  "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-medium",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90",
        secondary:
          "border border-[var(--divide)] text-[var(--text-primary)] transition-colors hover:bg-[var(--mock-row)]",
      },
      width: {
        auto: "",
        fit: "w-fit",
        responsive: "w-full justify-center sm:w-auto",
      },
    },
    defaultVariants: {
      variant: "primary",
      width: "auto",
    },
  },
);

export type CtaButtonVariants = VariantProps<typeof ctaButton>;

/**
 * Builds the CTA pill class. `className` is merged last through `cn`, so a call
 * site can still override a single token (tighter padding, added margin)
 * without restating the whole pill.
 */
export function ctaButtonClass(options: CtaButtonVariants & { className?: string } = {}) {
  const { className, ...variants } = options;
  return cn(ctaButton(variants), className);
}
