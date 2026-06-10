// FILE: BrowserNavButton.tsx
// Purpose: Shared ghost icon button for the browser chrome's back/forward/reload controls.
// Layer: Desktop-only presentational React component
// Exports: BrowserNavButton

import type { ReactNode } from "react";

import { Button } from "./ui/button";

export function BrowserNavButton(props: {
  icon: ReactNode;
  srLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-7 shrink-0"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="sr-only">{props.srLabel}</span>
    </Button>
  );
}
