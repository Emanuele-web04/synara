import { memo, useRef, type RefObject } from "react";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { anchoredToastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ANCHORED_TOAST_TIMEOUT_MS = 1000;

function showCopyToast(
  ref: RefObject<HTMLButtonElement | null>,
  title: string,
  description?: string,
): void {
  if (!ref.current) return;

  anchoredToastManager.add({
    data: {
      tooltipStyle: true,
    },
    positionerProps: {
      anchor: ref.current,
    },
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
    title,
    ...(description ? { description } : {}),
  });
}

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  size = "icon-xs",
  variant = "ghost",
  className,
}: {
  text: string;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showCopyToast(ref, "Copied!"),
    onError: (error: Error) => showCopyToast(ref, "Failed to copy", error.message),
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            ref={ref}
            size={size}
            variant={variant}
            disabled={isCopied}
            className={cn(
              size === "icon-xs" &&
                variant === "ghost" &&
                "size-auto rounded-none border-0 bg-transparent p-0 text-muted-foreground/55 shadow-none hover:bg-transparent hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0",
              className,
            )}
            onClick={() => copyToClipboard(text)}
            title="Copy message"
            aria-label="Copy message"
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>Copy to clipboard</p>
      </TooltipPopup>
    </Tooltip>
  );
});
