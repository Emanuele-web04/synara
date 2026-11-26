import { Button } from "./button";
import { useTranslation } from "~/i18n";

/** The shared accept/dismiss controls for inert proposals. */
export function ProposalActions(props: {
  pending: boolean;
  onResolve: (resolution: "accepted" | "dismissed") => void;
  acceptLabel?: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.pending}
        onClick={() => props.onResolve("dismissed")}
      >
        {t("automation:dismiss")}
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={props.pending}
        onClick={() => props.onResolve("accepted")}
      >
        {props.acceptLabel ?? t("automation:accept")}
      </Button>
    </div>
  );
}
