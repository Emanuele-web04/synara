import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "./button";

/** Shared by toast copy actions and inline diagnostic reports. */
export function CopyTextButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const title = isCopied ? `Copied ${label}` : `Copy ${label}`;
  return (
    <Button
      aria-label={title}
      title={title}
      className={className}
      size="xs"
      variant="ghost"
      onClick={() => copyToClipboard(text, undefined)}
    >
      {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      <span>{isCopied ? "Copied" : `Copy ${label}`}</span>
    </Button>
  );
}
