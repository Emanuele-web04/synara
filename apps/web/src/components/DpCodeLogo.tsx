// FILE: DpCodeLogo.tsx
// Purpose: Render the DP Code mark as an inline SVG that follows theme foreground color.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import { cn } from "~/lib/utils";
import { DPCODE_LOGO_PATH } from "~/assets/dpcodeLogoPath";

export function DpCodeLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox="0 0 1104 1209"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      <path d={DPCODE_LOGO_PATH} fill="currentColor" />
    </svg>
  );
}
