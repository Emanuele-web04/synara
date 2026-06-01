// FILE: SidebarLeadingIcon.tsx
// Purpose: Standardized leading icon slot used by sidebar menu rows and section headers.
// Layer: Sidebar UI primitive
// Exports: SidebarLeadingIcon
// Why: Collapses the repeated `inline-flex size-N items-center justify-center` icon
//      containers into one component with size/tone variants so every sidebar glyph
//      sits in an identically centered box.

import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

const SLOT_SIZE = {
  sm: "size-4",
  md: "size-5",
} as const;

export type SidebarLeadingIconSize = keyof typeof SLOT_SIZE;

export type SidebarLeadingIconProps = HTMLAttributes<HTMLSpanElement> & {
  size?: SidebarLeadingIconSize;
  tone?: string;
};

// `tone` defaults to the shared muted glyph color so call sites only override when
// the surrounding row intentionally dims its icon.
export const SidebarLeadingIcon = forwardRef<HTMLSpanElement, SidebarLeadingIconProps>(
  function SidebarLeadingIcon(
    { size = "md", tone = "text-muted-foreground/79", className, children, ...props },
    ref,
  ) {
    return (
      <span
        {...props}
        ref={ref}
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center",
          SLOT_SIZE[size],
          tone,
          className,
        )}
      >
        {children}
      </span>
    );
  },
);
