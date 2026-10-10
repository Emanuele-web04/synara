import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactElement } from "react";
import { cn } from "./utils";

const CENTRAL_ICON_BASE_PATHS = {
  reversed: "/central-icons-reversed",
  fill: "/central-icons-fill",
} as const;
export type CentralIconVariant = keyof typeof CENTRAL_ICON_BASE_PATHS;
const DEFAULT_CENTRAL_ICON_VARIANT: CentralIconVariant = "reversed";
const SVG_SUFFIX = ".svg";
const CENTRAL_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type CentralIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  name: string;
  label?: string | undefined;
  variant?: CentralIconVariant | undefined;
};

// build a public asset URL from the basename without allowing path traversal
export function getCentralIconUrl(
  name: string,
  variant: CentralIconVariant = DEFAULT_CENTRAL_ICON_VARIANT,
): string | null {
  // a non-string name (stale HMR state, bad dynamic call site) must degrade to no-icon + loud diagnostic instead of crashing the tree
  if (typeof name !== "string") {
    console.error("[central-icons] non-string icon name:", name, new Error("caller").stack);
    return null;
  }
  const normalizedName = name.endsWith(SVG_SUFFIX) ? name.slice(0, -SVG_SUFFIX.length) : name;

  if (!CENTRAL_ICON_NAME_PATTERN.test(normalizedName)) {
    return null;
  }

  return `${CENTRAL_ICON_BASE_PATHS[variant]}/${encodeURIComponent(normalizedName)}${SVG_SUFFIX}`;
}

// shared base classes so the React component and imperative DOM helper stay pixel-identical
const CENTRAL_ICON_BASE_CLASS = "inline-block size-4 shrink-0 bg-current";
export const CENTRAL_ICON_SLOT = "central-icon";

function centralIconMaskValue(iconUrl: string): string {
  return `url("${iconUrl}") center / contain no-repeat`;
}

export function extendButtonIconChildSelectors(className: string): string {
  let result = className;

  result = result.replace(
    /\[&_svg:not\(\[class\*='opacity-'\]\)\]:([^\s"']+)/g,
    (match, util) =>
      `${match} [&_[data-slot=${CENTRAL_ICON_SLOT}]:not([class*='opacity-'])]:${util}`,
  );

  result = result.replace(
    /((?:sm:|not-in-data-\[slot=input-group\]:)?\[&_svg:not\(\[class\*='size-'\]\)\]:[^\s"']+)/g,
    (match) => {
      const central = match.replace("[&_svg:not", `[&_[data-slot=${CENTRAL_ICON_SLOT}]:not`);
      return `${match} ${central}`;
    },
  );

  result = result.replace(
    /\[&_svg\]:([a-z0-9\-/[\].]+)/g,
    (match, util) => `[&_svg,&_[data-slot=${CENTRAL_ICON_SLOT}]]:${util}`,
  );

  return result;
}

export const CentralIcon = forwardRef<HTMLSpanElement, CentralIconProps>(function CentralIcon(
  { name, label, variant, className, style, ...props },
  ref,
) {
  const iconUrl = getCentralIconUrl(name, variant);

  if (!iconUrl) {
    return null;
  }

  const maskValue = centralIconMaskValue(iconUrl);
  const maskStyle = {
    WebkitMask: maskValue,
    mask: maskValue,
    ...style,
  } satisfies CSSProperties;

  return (
    <span
      {...props}
      ref={ref}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot={CENTRAL_ICON_SLOT}
      className={cn(CENTRAL_ICON_BASE_CLASS, className)}
      style={maskStyle}
    />
  );
});

// adapt a Central icon name to ComponentType so Central glyphs drop in wherever a react-icons/lucide component was expected
export function createCentralIconComponent(
  name: string,
  variant?: CentralIconVariant,
): (props: { className?: string }) => ReactElement {
  function CentralIconGlyph({ className }: { className?: string }) {
    return <CentralIcon name={name} variant={variant} className={className} />;
  }
  CentralIconGlyph.displayName = `CentralIconGlyph(${name})`;
  return CentralIconGlyph;
}

// imperative twin of CentralIcon for non-React surfaces (Lexical composer chips build DOM by hand); null on invalid name
export function createCentralIconElement(
  name: string,
  className?: string,
  variant?: CentralIconVariant,
): HTMLSpanElement | null {
  const iconUrl = getCentralIconUrl(name, variant);
  if (!iconUrl) {
    return null;
  }

  const span = document.createElement("span");
  span.setAttribute("aria-hidden", "true");
  span.dataset.slot = CENTRAL_ICON_SLOT;
  span.className = cn(CENTRAL_ICON_BASE_CLASS, className);
  const maskValue = centralIconMaskValue(iconUrl);
  span.style.setProperty("-webkit-mask", maskValue);
  span.style.setProperty("mask", maskValue);
  return span;
}
