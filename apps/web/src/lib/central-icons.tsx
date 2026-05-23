// FILE: central-icons.tsx
// Purpose: Resolve and render Central icon SVGs shipped as static web assets.
// Layer: web UI utility
// Exports: CentralIcon, getCentralIconUrl
// Depends on: Vite public asset serving and app className merging utilities.

import { forwardRef, type CSSProperties, type HTMLAttributes } from "react";
import { cn } from "./utils";

const CENTRAL_ICON_BASE_PATH = "/central-icons-reversed";
const SVG_SUFFIX = ".svg";
const CENTRAL_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type CentralIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  name: string;
  label?: string;
};

// Builds a public asset URL from the icon basename without allowing path traversal.
export function getCentralIconUrl(name: string): string | null {
  const normalizedName = name.endsWith(SVG_SUFFIX) ? name.slice(0, -SVG_SUFFIX.length) : name;

  if (!CENTRAL_ICON_NAME_PATTERN.test(normalizedName)) {
    return null;
  }

  return `${CENTRAL_ICON_BASE_PATH}/${encodeURIComponent(normalizedName)}${SVG_SUFFIX}`;
}

export const CentralIcon = forwardRef<HTMLSpanElement, CentralIconProps>(function CentralIcon(
  { name, label, className, style, ...props },
  ref,
) {
  const iconUrl = getCentralIconUrl(name);

  if (!iconUrl) {
    return null;
  }

  const maskStyle = {
    WebkitMask: `url("${iconUrl}") center / contain no-repeat`,
    mask: `url("${iconUrl}") center / contain no-repeat`,
    ...style,
  } satisfies CSSProperties;

  return (
    <span
      {...props}
      ref={ref}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-4 shrink-0 bg-current", className)}
      style={maskStyle}
    />
  );
});
