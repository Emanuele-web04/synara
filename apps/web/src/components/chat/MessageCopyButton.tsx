import { memo, useRef, type RefObject } from "react";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { anchoredToastManager } from "../ui/toast";
import { MessageActionButton } from "./MessageActionButton";

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
    <MessageActionButton
      ref={ref}
      label="Copy message"
      tooltip="Copy to clipboard"
      disabled={isCopied}
      className={cn(variant === "outline" && "border", size === "xs" && "h-5 px-1.5", className)}
      onClick={() => copyToClipboard(text)}
    >
      {isCopied ? (
        <CheckIcon className="size-3.5 text-success" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </MessageActionButton>
  );
});
