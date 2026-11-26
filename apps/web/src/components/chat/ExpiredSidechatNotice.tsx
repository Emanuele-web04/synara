import { Button } from "~/components/ui/button";
import { useTranslation } from "~/i18n";

export function ExpiredSidechatNotice({ onStartNew }: { readonly onStartNew: () => void }) {
  const { t } = useTranslation();

  return (
    <div
      className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2 text-ui"
      role="status"
    >
      <span className="min-w-0 text-[var(--color-text-foreground-secondary)]">
        {t("chat:thisSideChatExpiredAfterAPeriodOfInactivity")}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onStartNew}>
        {t("chat:startNew")}
      </Button>
    </div>
  );
}
