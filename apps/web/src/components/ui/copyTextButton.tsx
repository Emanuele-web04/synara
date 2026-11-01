import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "./button";
import { useTranslation } from "~/i18n";

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
  const { t } = useTranslation();

  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const title = isCopied
    ? t("common:copied", { value0: label })
    : t("settings:copy", { value0: label });
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
      <span>{isCopied ? t("chat:theme_copied") : t("settings:copy", { value0: label })}</span>
    </Button>
  );
}
