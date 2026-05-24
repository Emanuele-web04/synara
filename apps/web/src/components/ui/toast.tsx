"use client";

import { Toast, type ToastObject } from "@base-ui/react/toast";
import { useEffect, useMemo, type CSSProperties } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "~/lib/icons";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "~/components/ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { buildVisibleToastLayout, shouldHideCollapsedToastContent } from "./toast.logic";
import { parseDiffRouteSearch } from "../../diffRouteSearch";
import { selectSplitView, useSplitViewStore } from "../../splitViewStore";
import {
  resolveVisibleToastThreadIds,
  shouldRenderToastForVisibleThreads,
} from "./toastRouteVisibility";

type ThreadToastData = {
  allowCrossThreadVisibility?: boolean;
  copyText?: string;
  secondaryActionProps?: React.ComponentProps<typeof Button>;
  threadId?: ThreadId | null;
  tooltipStyle?: boolean;
  dismissAfterVisibleMs?: number;
};

const toastManager = Toast.createToastManager<ThreadToastData>();
const anchoredToastManager = Toast.createToastManager<ThreadToastData>();
type ToastId = ReturnType<typeof toastManager.add>;
const threadToastVisibleTimeoutRemainingMs = new Map<ToastId, number>();

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

const COMPACT_TOAST_ROOT_CLASS =
  "w-max max-w-[min(calc(100vw-2rem),28rem)] rounded-lg border border-[color-mix(in_srgb,var(--color-text-accent)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-text-accent)_50%,transparent)] text-white shadow-lg/15 backdrop-blur-xl before:hidden dark:border-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)] dark:bg-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)]";

const EXPANDED_TOAST_ROOT_CLASS =
  "w-full rounded-xl border border-[color-mix(in_srgb,var(--color-text-accent)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-text-accent)_50%,transparent)] text-white shadow-lg/15 backdrop-blur-xl before:hidden dark:border-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)] dark:bg-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)]";

function shouldUseCompactToast(toast: ToastObject<ThreadToastData>): boolean {
  return !toast.data?.copyText && !toast.actionProps && !toast.data?.secondaryActionProps;
}

function toastRootClassName(position: ToastPosition, compact: boolean): string {
  return cn(
    compact ? COMPACT_TOAST_ROOT_CLASS : EXPANDED_TOAST_ROOT_CLASS,
    position.includes("center") ? "mx-auto" : compact ? "" : "w-full",
  );
}

function toastIconClassName(type: ToastObject<ThreadToastData>["type"]): string {
  return cn(
    "text-white/92",
    type === "loading" && "animate-spin opacity-90",
  );
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function shouldRenderForActiveThread(
  data: ThreadToastData | undefined,
  visibleThreadIds: ReadonlySet<ThreadId>,
): boolean {
  return shouldRenderToastForVisibleThreads({
    allowCrossThreadVisibility: data?.allowCrossThreadVisibility,
    toastThreadId: data?.threadId,
    visibleThreadIds,
  });
}

function useVisibleThreadIdsFromRoute(): ReadonlySet<ThreadId> {
  const activeThreadId = useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const routeSearch = useSearch({
    strict: false,
    select: (search) => parseDiffRouteSearch(search),
  });
  const splitView = useSplitViewStore(selectSplitView(routeSearch.splitViewId ?? null));

  return useMemo(() => {
    return resolveVisibleToastThreadIds({ activeThreadId, splitView });
  }, [activeThreadId, splitView]);
}

function ThreadToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
}) {
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let remainingMs = threadToastVisibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      threadToastVisibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      threadToastVisibleTimeoutRemainingMs.set(toastId, remainingMs);
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    const syncTimer = () => {
      const shouldRun = document.visibilityState === "visible" && document.hasFocus();
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId]);

  return null;
}

function ToastActions({
  actionProps,
  copyText,
  secondaryActionProps,
}: {
  actionProps: ToastObject<ThreadToastData>["actionProps"];
  copyText: string | undefined;
  secondaryActionProps: ThreadToastData["secondaryActionProps"];
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  if (!actionProps && !copyText && !secondaryActionProps) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {copyText && (
        <Button
          aria-label={isCopied ? "Copied error message" : "Copy error message"}
          className="self-start border-white/20 bg-white/10 text-white hover:bg-white/20"
          onClick={() => {
            copyToClipboard(copyText, undefined);
          }}
          size="xs"
          title={isCopied ? "Copied error message" : "Copy error message"}
          variant="outline"
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          <span>{isCopied ? "Copied" : "Copy"}</span>
        </Button>
      )}
      {actionProps && (
        <Toast.Action
          {...actionProps}
          className={cn(
            buttonVariants({ size: "xs", variant: "outline" }),
            "self-start border-white/20 bg-white/10 text-white hover:bg-white/20",
            actionProps.className,
          )}
          data-slot="toast-action"
        >
          {actionProps.children}
        </Toast.Action>
      )}
      {secondaryActionProps && (
        <Button
          {...secondaryActionProps}
          className={cn(
            "self-start border-white/20 bg-white/10 text-white hover:bg-white/20",
            secondaryActionProps.className,
          )}
          size={secondaryActionProps.size ?? "xs"}
          variant={secondaryActionProps.variant ?? "outline"}
        />
      )}
    </div>
  );
}

function ToastCloseButton({ compact = false }: { compact?: boolean }) {
  return (
    <Toast.Close
      aria-label="Dismiss toast"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35",
        compact ? "size-5" : "absolute top-2 right-2 size-6",
      )}
      data-slot="toast-close"
      title="Dismiss toast"
    >
      <XIcon className={compact ? "size-3" : "size-3.5"} />
    </Toast.Close>
  );
}

function ToastSurface({
  toast,
  compact,
  hideCollapsedContent,
}: {
  toast: ToastObject<ThreadToastData>;
  compact: boolean;
  hideCollapsedContent: boolean;
}) {
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;

  return (
    <Toast.Content
      className={cn(
        "pointer-events-auto relative flex overflow-hidden transition-opacity duration-250 data-expanded:opacity-100",
        compact
          ? "items-center gap-2 px-3 py-1.5 pr-1.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-none"
          : "items-start gap-2 px-3.5 py-3 pr-10 text-sm",
        hideCollapsedContent &&
          "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
      )}
    >
      {Icon ? (
        <div
          className={cn(
            "shrink-0 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            compact
              ? "[&>svg]:size-3.5"
              : "[&>svg]:h-lh [&>svg]:w-4",
          )}
          data-slot="toast-icon"
        >
          <Icon className={toastIconClassName(toast.type)} />
        </div>
      ) : null}

      <div className={cn("min-w-0 flex-1", compact ? "flex items-center" : "flex flex-col gap-0.5")}>
        <Toast.Title
          className={cn(
            "min-w-0 font-normal",
            compact ? "truncate whitespace-nowrap" : "break-words",
          )}
          data-slot="toast-title"
        />
        {!compact ? (
          <Toast.Description
            className="min-w-0 break-words text-white/72"
            data-slot="toast-description"
          />
        ) : null}
        {!compact ? (
          <ToastActions
            actionProps={toast.actionProps}
            copyText={toast.data?.copyText}
            secondaryActionProps={toast.data?.secondaryActionProps}
          />
        ) : null}
      </div>

      <ToastCloseButton compact={compact} />
    </Toast.Content>
  );
}

function ToastProvider({ children, position = "top-center", ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position = "top-center" }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const visibleThreadIds = useVisibleThreadIdsFromRoute();
  const isTop = position.startsWith("top");
  const visibleToasts = toasts.filter((toast) =>
    shouldRenderForActiveThread(toast.data, visibleThreadIds),
  );
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of threadToastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        threadToastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-[200] mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-sm [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          // Vertical positioning
          "data-[position=top-center]:top-4",
          "data-[position=top-left]:top-[calc(var(--toast-inset)+52px)]",
          "data-[position=top-right]:top-[calc(var(--toast-inset)+52px)]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );
          const compact = shouldUseCompactToast(toast);

          return (
            <Toast.Root
              className={cn(
                "absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) select-none [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                toastRootClassName(position, compact),
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // Define some variables
                // Base UI exposes a shared front-most height for the collapsed stack.
                // If that shared measurement is briefly stale, long content can render
                // outside the card until hover expands the toast and swaps to its own height.
                "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))] [--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Top-center uses a flat banner stack without peek/shrink offsets.
                "data-[position=top-center]:[--toast-peek:0px] data-[position=top-center]:[--toast-scale:1] data-[position=top-center]:[--toast-shrink:0]",
                "data-[position=top-center]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-swipe-movement-y))]",
                "data-[position=top-center]:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-offset-y)+var(--toast-swipe-movement-y)))]",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded state
                "data-expanded:h-(--toast-height)",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position=top-center]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                // Ending animations (direction-aware)
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <ThreadToastVisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <ToastSurface
                compact={compact}
                hideCollapsedContent={hideCollapsedContent}
                toast={toast}
              />
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const visibleThreadIds = useVisibleThreadIdsFromRoute();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport className="outline-none" data-slot="toast-viewport-anchored">
        {toasts
          .filter((toast) => shouldRenderForActiveThread(toast.data, visibleThreadIds))
          .map((toast) => {
            const tooltipStyle = toast.data?.tooltipStyle ?? false;
            const positionerProps = toast.positionerProps;
            const compact = !tooltipStyle && shouldUseCompactToast(toast);

            if (!positionerProps?.anchor) {
              return null;
            }

            return (
              <Toast.Positioner
                className="z-50 max-w-[min(--spacing(64),var(--available-width))]"
                data-slot="toast-positioner"
                key={toast.id}
                sideOffset={positionerProps.sideOffset ?? 4}
                toast={toast}
              >
                <Toast.Root
                  className={cn(
                    "relative text-balance transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
                    tooltipStyle
                      ? "rounded-md border bg-popover text-popover-foreground text-xs shadow-md/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"
                      : compact
                        ? COMPACT_TOAST_ROOT_CLASS
                        : EXPANDED_TOAST_ROOT_CLASS,
                  )}
                  data-slot="toast-popup"
                  toast={toast}
                >
                  {tooltipStyle ? (
                    <Toast.Content className="pointer-events-auto px-2 py-1">
                      <Toast.Title data-slot="toast-title" />
                    </Toast.Content>
                  ) : (
                    <ToastSurface compact={compact} hideCollapsedContent={false} toast={toast} />
                  )}
                </Toast.Root>
              </Toast.Positioner>
            );
          })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export {
  ToastProvider,
  type ToastPosition,
  toastManager,
  AnchoredToastProvider,
  anchoredToastManager,
};
