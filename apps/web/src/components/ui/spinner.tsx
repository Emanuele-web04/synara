import { Loader2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "react-i18next";

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  const { t } = useTranslation();
  return (
    <Loader2Icon
      aria-label={t("ui.spinner.loading")}
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
