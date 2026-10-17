import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "./button";

/** Shared by toast copy actions and inline diagnostic reports. */
export function CopyTextButton({
  text,
  label,
  className,
  iconOnly = false,
}: {
  text: string;
  label: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const title = isCopied ? `Copied ${label}` : `Copy ${label}`;
  return (
    <Button
      aria-label={title}
      title={title}
      className={className}
      size={iconOnly ? "icon-xs" : "xs"}
      variant="ghost"
      onClick={() => copyToClipboard(text, undefined)}
    >
      {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {iconOnly ? null : <span>{isCopied ? "Copied" : `Copy ${label}`}</span>}
    </Button>
  );
}
