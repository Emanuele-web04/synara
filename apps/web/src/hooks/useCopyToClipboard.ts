import * as React from "react";

function fallbackCopyTextToClipboard(value: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const activeElement =
    typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const selection = document.getSelection();
  const savedRanges =
    selection == null
      ? []
      : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  const textarea = document.createElement("textarea");

  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } finally {
    textarea.remove();

    if (selection) {
      selection.removeAllRanges();
      for (const range of savedRanges) {
        selection.addRange(range);
      }
    }

    activeElement?.focus();
  }
}

export async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("Clipboard API unavailable.");
  }

  if (!value) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      if (fallbackCopyTextToClipboard(value)) {
        return;
      }
      throw error;
    }
  }

  if (fallbackCopyTextToClipboard(value)) {
    return;
  }

  throw new Error("Clipboard API unavailable.");
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  onCopy,
  onError,
}: {
  timeout?: number;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void copyTextToClipboard(value).then(
      () => {
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        if (onErrorRef.current) {
          onErrorRef.current(error, ctx);
        } else {
          console.error(error);
        }
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
