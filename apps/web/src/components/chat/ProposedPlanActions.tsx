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
      toastManager.add({ type: "success", title: t("chat:proposedPlan_copiedToast") });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: t("chat:proposedPlan_copyFailedToast"),
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
        title: t("chat:proposedPlan_workspaceUnavailable"),
        description: t("chat:proposedPlan_workspaceUnavailableDesc"),
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
          title: t("chat:proposedPlan_downloadedToast"),
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: t("chat:proposedPlan_downloadFailedToast"),
          description:
            error instanceof Error ? error.message : t("common:proposedPlan_unknownError"),
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
        title: t("chat:proposedPlan_exportUnavailable"),
        description: t("chat:proposedPlan_exportUnavailableDesc"),
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
          title: t("chat:proposedPlan_exportedToast"),
          description: filePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: t("chat:proposedPlan_exportFailedToast"),
          description:
            error instanceof Error ? error.message : t("common:proposedPlan_unknownError"),
        });
      })
      .finally(() => setIsExporting(false));
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <PlanActionButton
        label={t("chat:proposedPlan_downloadToFolder")}
        onClick={handleDownload}
        variant={variant}
        className={buttonClassName}
        busy={isDownloading}
      >
        <ArrowDownIcon className={cn("size-3.5", iconClassName)} />
      </PlanActionButton>
      <PlanActionButton
        label={t("chat:proposedPlan_exportFile")}
        onClick={handleExport}
        variant={variant}
        className={buttonClassName}
        busy={isExporting}
      >
        <ArrowUpIcon className={cn("size-3.5", iconClassName)} />
      </PlanActionButton>
      <PlanActionButton
        label={isCopied ? t("chat:theme_copied") : t("chat:proposedPlan_copyAsMarkdown")}
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
