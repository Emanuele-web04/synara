import { forwardRef } from "react";

import { SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Input, type InputProps } from "./input";

export const SearchInput = forwardRef<HTMLInputElement, InputProps>(function SearchInput(
  { className, type: typeProp, size: sizeProp, variant: variantProp, shape, ...props },
  ref,
) {
  const type = typeProp ?? "text";
  const size = sizeProp ?? "sm";
  const variant = variantProp ?? "soft";
  return (
    <div className="relative w-full">
      <Input
        ref={ref}
        type={type}
        size={size}
        variant={variant}
        {...(shape ? { shape } : {})}
        className={cn(
          shape === "capsule" ? "[&>[data-slot=input]]:pl-9" : "[&>[data-slot=input]]:pl-8",
          className,
        )}
        {...props}
      />
      <SearchIcon
        className={cn(
          "pointer-events-none absolute top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70",
          shape === "capsule" ? "left-3.5" : "left-2.5",
        )}
        aria-hidden="true"
      />
    </div>
  );
});
