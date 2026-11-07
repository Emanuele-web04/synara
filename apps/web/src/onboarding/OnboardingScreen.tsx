// FILE: OnboardingScreen.tsx
// Purpose: One full-window onboarding screen: the numbered two-tone hero (muted lead,
//          strong statement), its description and actions, then the stage below a
//          full-width hairline. The 1200px column's side guides run from the header to the
//          bottom edge. Enter triggers the primary action unless focus is on a control.
// Layer: Web UI layout component

import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

export interface OnboardingAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
}

/** The column every screen shares, with its side guides. */
export const ONBOARDING_COLUMN_CLASS_NAME =
  "mx-auto w-full max-w-[1200px] border-x border-foreground/8";

const INTERACTIVE_TARGET =
  "input, textarea, select, button, a, [contenteditable=''], [contenteditable='true'], [role='switch'], [role='checkbox'], [role='textbox'], .xterm";

function usePrimaryOnEnter(action: OnboardingAction | undefined) {
  const actionRef = useRef(action);
  actionRef.current = action;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = actionRef.current;
      if (!current || current.disabled || current.busy) return;
      if (event.key !== "Enter" || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE_TARGET)) return;
      event.preventDefault();
      current.onClick();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function OnboardingScreen(props: {
  /** Two-digit step number shown above the title; omitted on the welcome and last screens. */
  readonly number?: string;
  readonly numberSuffix?: string;
  readonly lead: string;
  readonly statement: string;
  readonly description: ReactNode;
  readonly primary?: OnboardingAction | undefined;
  readonly secondary?: OnboardingAction | undefined;
  /** Extra controls beside the actions (a status chip, a path field). */
  readonly actionsExtra?: ReactNode;
  /** `inline` sits under the description (hero screens); `side` aligns to the right. */
  readonly actionsPlacement?: "inline" | "side";
  /** Right-hand hero content in place of side actions (the final receipt). */
  readonly aside?: ReactNode;
  /** Shown under the actions (errors, inline forms). */
  readonly footnote?: ReactNode;
  readonly stageClassName?: string;
  readonly children?: ReactNode;
}) {
  const placement = props.actionsPlacement ?? "side";
  usePrimaryOnEnter(props.primary);

  const actions =
    props.primary || props.secondary || props.actionsExtra ? (
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center gap-2",
          placement === "inline" && "pt-1.5",
        )}
      >
        {placement === "side" && props.secondary ? (
          <SecondaryButton action={props.secondary} />
        ) : null}
        {placement === "side" ? props.actionsExtra : null}
        {props.primary ? (
          <Button
            shape="capsule"
            size="lg"
            className="gap-2 px-4"
            disabled={props.primary.disabled || props.primary.busy}
            onClick={props.primary.onClick}
          >
            {props.primary.busy ? <Spinner className="size-3.5" aria-hidden /> : null}
            {props.primary.label}
            <span aria-hidden className="text-ui-sm opacity-50">
              ↵
            </span>
          </Button>
        ) : null}
        {placement === "inline" && props.secondary ? (
          <SecondaryButton action={props.secondary} />
        ) : null}
        {placement === "inline" ? props.actionsExtra : null}
      </div>
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className={cn(ONBOARDING_COLUMN_CLASS_NAME, "shrink-0 px-8 pt-7 pb-8")}>
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div className="flex max-w-[760px] min-w-0 flex-col gap-4">
            {props.number ? (
              <span className="text-xl text-foreground/40 tabular-nums">
                {props.number}
                {props.numberSuffix ? ` · ${props.numberSuffix}` : null}
              </span>
            ) : null}
            <DialogTitle className="font-sans text-[clamp(2.25rem,3.4vw,3rem)] leading-[1.08] font-normal tracking-[-0.035em] text-foreground">
              <span className="text-foreground/40">{props.lead}</span>
              <br />
              {props.statement}
            </DialogTitle>
            <DialogDescription className="max-w-[640px] text-ui-lg leading-relaxed text-muted-foreground">
              {props.description}
            </DialogDescription>
            {placement === "inline" ? actions : null}
            {props.footnote}
          </div>
          {placement === "side" ? actions : null}
          {props.aside}
        </div>
      </section>
      <div className="h-px shrink-0 bg-foreground/8" />
      <section
        className={cn(
          ONBOARDING_COLUMN_CLASS_NAME,
          "relative min-h-0 flex-1 overflow-y-auto",
          props.stageClassName,
        )}
      >
        {props.children}
      </section>
    </div>
  );
}

function SecondaryButton(props: { action: OnboardingAction }) {
  return (
    <Button
      shape="capsule"
      size="lg"
      variant="outline"
      className="bg-background/70 px-4"
      disabled={props.action.disabled}
      onClick={props.action.onClick}
    >
      {props.action.label}
    </Button>
  );
}

/** A small capsule that reports a live state next to the actions ("Waiting for iPhone"). */
export function OnboardingStatusChip(props: {
  readonly tone: "live" | "success";
  readonly children: ReactNode;
}) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex h-10 items-center gap-2 rounded-full border px-4 text-ui sm:h-9",
        props.tone === "live"
          ? "border-[#317CFF]/30 bg-[#317CFF]/8 text-[#317CFF]"
          : "border-success/30 bg-success/8 text-success",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          props.tone === "live" ? "bg-[#317CFF] motion-safe:animate-pulse" : "bg-success",
        )}
      />
      {props.children}
    </span>
  );
}
