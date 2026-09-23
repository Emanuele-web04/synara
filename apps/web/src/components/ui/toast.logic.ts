export const DEFAULT_TOAST_TIMEOUT_MS = 10_000;

// A named text the user can copy from a toast action (e.g. a path left on
// disk). Each item renders its own button so every path is copyable.
export type ToastCopyItem = {
  readonly label: string;
  readonly text: string;
};

// Compact toasts have no actions row — anything with an action or copyable
// content renders expanded.
export function shouldUseCompactToast(toast: {
  readonly actionProps?: unknown;
  readonly data?:
    | {
        readonly compactContextual?: boolean;
        readonly copyItems?: ReadonlyArray<unknown>;
        readonly copyText?: string;
        readonly secondaryActionProps?: unknown;
      }
    | undefined;
}): boolean {
  if (toast.data?.compactContextual) {
    return true;
  }
  return (
    !toast.data?.copyText &&
    !toast.data?.copyItems?.length &&
    !toast.actionProps &&
    !toast.data?.secondaryActionProps
  );
}

export function shouldHideCollapsedToastContent(
  visibleToastIndex: number,
  visibleToastCount: number,
): boolean {
  // Keep the front-most toast readable even if Base UI marks it as "behind"
  // due to toasts hidden by thread filtering.
  if (visibleToastCount <= 1) return false;
  return visibleToastIndex > 0;
}

export function shouldRunVisibleToastAutoDismiss({
  paused,
  documentVisible,
  windowFocused,
  toastFocused,
}: {
  paused: boolean;
  documentVisible: boolean;
  windowFocused: boolean;
  toastFocused: boolean;
}): boolean {
  return !paused && documentVisible && windowFocused && !toastFocused;
}

type ToastWithHeight = {
  height?: number | null | undefined;
};

type VisibleToastLayoutItem<TToast extends object> = {
  toast: TToast;
  visibleIndex: number;
  offsetY: number;
};

export function buildVisibleToastLayout<TToast extends object>(
  visibleToasts: readonly (TToast & ToastWithHeight)[],
): {
  frontmostHeight: number;
  items: VisibleToastLayoutItem<TToast & ToastWithHeight>[];
} {
  let offsetY = 0;

  return {
    frontmostHeight: normalizeToastHeight(visibleToasts[0]?.height),
    items: visibleToasts.map((toast, visibleIndex) => {
      const item = {
        toast,
        visibleIndex,
        offsetY,
      };

      offsetY += normalizeToastHeight(toast.height);
      return item;
    }),
  };
}

function normalizeToastHeight(height: number | null | undefined): number {
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
}
