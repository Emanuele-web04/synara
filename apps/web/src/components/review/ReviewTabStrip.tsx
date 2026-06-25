import { type ReactNode, useRef } from "react";

import { cn } from "~/lib/utils";

export interface ReviewTabItem {
  id: string;
  label: string;
  count?: number | null;
}

export function ReviewTabStrip(props: {
  tabs: ReadonlyArray<ReviewTabItem>;
  value: string;
  onValueChange: (id: string) => void;
  actions?: ReactNode;
  className?: string;
  size?: "compact" | "roomy";
  "aria-label"?: string;
}) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const size = props.size ?? "compact";

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") {
      return;
    }
    event.preventDefault();
    const current = props.tabs.findIndex((tab) => tab.id === props.value);
    const last = props.tabs.length - 1;
    const nextIndex =
      key === "Home"
        ? 0
        : key === "End"
          ? last
          : (current + (key === "ArrowRight" ? 1 : -1) + props.tabs.length) % props.tabs.length;
    const next = props.tabs[nextIndex];
    if (next) {
      props.onValueChange(next.id);
      tabRefs.current.get(next.id)?.focus();
    }
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-border/60",
        size === "roomy" ? "h-12 px-3" : "h-9 px-2",
        props.className,
      )}
    >
      <div
        role="tablist"
        aria-label={props["aria-label"]}
        aria-orientation="horizontal"
        onKeyDown={moveFocus}
        className="-my-2 flex min-w-0 items-center gap-1 overflow-x-auto py-2"
      >
        {props.tabs.map((tab) => {
          const active = tab.id === props.value;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) {
                  tabRefs.current.set(tab.id, node);
                } else {
                  tabRefs.current.delete(tab.id);
                }
              }}
              type="button"
              role="tab"
              id={`review-tab-${tab.id}`}
              aria-controls={`review-tabpanel-${tab.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-active={active || undefined}
              onClick={() => props.onValueChange(tab.id)}
              className={cn(
                "relative inline-flex items-center gap-1 whitespace-nowrap rounded-lg font-medium outline-none",
                "transition-[background-color,color,transform] duration-150 ease-out motion-reduce:transition-none",
                "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                size === "roomy" ? "h-8 px-3 text-[13px]" : "h-6 px-2.5 text-[12px]",
                active
                  ? "bg-muted text-foreground font-semibold after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary active:scale-[0.96] motion-reduce:active:scale-100"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground active:scale-[0.96] motion-reduce:active:scale-100",
              )}
            >
              <span>{tab.label}</span>
              {tab.count != null && tab.count > 0 ? (
                <span className="tabular-nums text-[11px] font-medium leading-none text-muted-foreground">
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {props.actions ? (
        <div className="ms-auto flex shrink-0 items-center gap-1 self-center">{props.actions}</div>
      ) : null}
    </div>
  );
}
