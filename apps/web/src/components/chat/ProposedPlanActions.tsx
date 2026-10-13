import { memo, useMemo, useState, type ReactNode } from "react";
import {
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
} from "../../proposedPlan";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { IconButton } from "../ui/icon-button";
import { toastManager } from "../ui/toast";
import { useTranslation } from "~/i18n";

type PlanActionVariant = "outline" | "ghost";

interface ProposedPlanActionsProps {
  planMarkdown: string;
  workspaceRoot: string | undefined;
  variant?: PlanActionVariant;
  className?: string;
  buttonClassName?: string;
  iconClassName?: string;
}

export const ProposedPlanActions = memo(function ProposedPlanActions({
  planMarkdown,
  workspaceRoot,
  variant: variantProp,
  className,
  buttonClassName,
  iconClassName,
}: ProposedPlanActionsProps) {
  const { t } = useTranslation();

  const variant = variantProp ?? "outline";
  const [isDownloading, setIsDownloading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const filename = useMemo(() => buildProposedPlanMarkdownFilename(planMarkdown), [planMarkdown]);
  const markdown = useMemo(() => normalizePlanMarkdownForExport(planMarkdown), [planMarkdown]);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({ type: "success", title: t("Plan copied as markdown") });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: t("Could not copy plan"),
        description: error.message,
      });
    },
  });

  const handleCopy = () => {
    copyToClipboard(markdown, undefined);
  };

  const handleDownload = () => {
    const api = readNativeApi();
    if (!api || !workspaceRoot) {
      toastManager.add({
        type: "error",
        title: t("Workspace path is unavailable"),
        description: t("This thread does not have a workspace path to download into."),
      });
      return;
    }

    setIsDownloading(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: `.plan/${filename}`,
        contents: markdown,
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: t("Plan downloaded"),
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: t("Could not download plan"),
          description: error instanceof Error ? error.message : t("An error occurred."),
        });
      })
      .finally(() => setIsDownloading(false));
  };

  const handleExport = () => {
    const api = readNativeApi();
    if (!api) return;

    if (!api.dialogs.saveFile) {
      toastManager.add({
        type: "error",
        title: t("Export is unavailable"),
        description: t("Exporting plans requires the desktop app."),
      });
      return;
    }

    setIsExporting(true);
    void api.dialogs
      .saveFile({
        defaultFilename: filename,
        contents: markdown,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      })
      .then((filePath) => {
        if (!filePath) return;
        toastManager.add({
          type: "success",
          title: t("Plan exported"),
          description: filePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: t("Could not export plan"),
          description: error instanceof Error ? error.message : t("An error occurred."),
        });
      })
      .finally(() => setIsExporting(false));
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <PlanActionButton
        label={t("Download to .plan folder")}
        onClick={handleDownload}
        variant={variant}
        className={buttonClassName}
        busy={isDownloading}
      >
        <ArrowDownIcon className={cn("size-3.5", iconClassName)} />
      </PlanActionButton>
      <PlanActionButton
        label={t("Export markdown file")}
        onClick={handleExport}
        variant={variant}
        className={buttonClassName}
        busy={isExporting}
      >
        <ArrowUpIcon className={cn("size-3.5", iconClassName)} />
      </PlanActionButton>
      <PlanActionButton
        label={isCopied ? t("Copied") : t("Copy as markdown")}
        onClick={handleCopy}
        variant={variant}
        className={buttonClassName}
      >
        <CopyIcon className={cn("size-3.5", iconClassName)} />
      </PlanActionButton>
    </div>
  );
});

function PlanActionButton({
  label,
  onClick,
  variant,
  className,
  busy: busyProp,
  children,
}: {
  label: string;
  onClick: () => void;
  variant: PlanActionVariant;
  className: string | undefined;
  busy?: boolean;
  children: ReactNode;
}) {
  const busy = busyProp ?? false;
  return (
    <IconButton
      label={label}
      tooltip={label}
      className={cn("shrink-0", className)}
      disabled={busy}
      size="icon-xs"
      variant={variant}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
}
