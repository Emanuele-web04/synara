import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "~/lib/utils";

function Separator({
  className,
  orientation: orientationProp,
  ...props
}: SeparatorPrimitive.Props) {
  const orientation = orientationProp ?? "horizontal";
  return (
    <SeparatorPrimitive
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        className,
      )}
      data-slot="separator"
      orientation={orientation}
      {...props}
    />
  );
}

export { Separator };
