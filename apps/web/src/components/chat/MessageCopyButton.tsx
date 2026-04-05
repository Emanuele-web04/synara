import { memo } from "react";
import { CopyIcon, CheckIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="size-auto rounded-none border-0 bg-transparent p-0 text-muted-foreground/55 shadow-none hover:bg-transparent hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
      onClick={() => copyToClipboard(text)}
      title="Copy message"
      aria-label="Copy message"
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});
