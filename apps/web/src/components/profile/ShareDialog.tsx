// FILE: ShareDialog.tsx
// Purpose: "Share your activity" dialog — previews the virality card and exports it to
// PNG fully on-device, then copies to clipboard + opens a social composer, or saves the
// file. Mirrors the reference share sheet (Copy / X / LinkedIn / Reddit / Save).
// Layer: web profile feature.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SiReddit, SiX } from "react-icons/si";
import { FaLinkedinIn } from "react-icons/fa6";
import type { ProfileStats, ProfileTokenStats } from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { CopyIcon, DownloadIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, ShareCard } from "./ShareCard";
import {
  copyImageToClipboard,
  downloadBlob,
  openExternalUrl,
  renderNodeToPngBlob,
  type ShareTarget,
  shareIntentUrl,
} from "./shareCardExport";

const PREVIEW_WIDTH = 480;
const CARD_EXPORT_SIZE = { width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT } as const;
type CopyResult = "copied" | "render-failed" | "clipboard-unavailable";

interface ShareDialogProps {
  readonly stats: ProfileStats;
  readonly tokenStats: ProfileTokenStats | null;
  readonly displayName: string;
  readonly handle: string;
  readonly avatarColor: string;
  readonly avatarImage: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ShareDialog({
  stats,
  tokenStats,
  displayName,
  handle,
  avatarColor,
  avatarImage,
  open,
  onOpenChange,
}: ShareDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<ShareTarget | "copy" | "save" | null>(null);
  const [previewWidth, setPreviewWidth] = useState(PREVIEW_WIDTH);
  const [status, setStatus] = useState<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) {
      return;
    }
    const node = previewRef.current;
    if (!node) {
      return;
    }

    const updatePreviewWidth = (width: number) => {
      setPreviewWidth(Math.max(1, Math.min(PREVIEW_WIDTH, Math.floor(width))));
    };
    updatePreviewWidth(node.clientWidth || PREVIEW_WIDTH);

    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => updatePreviewWidth(node.clientWidth || PREVIEW_WIDTH);
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    const observer = new ResizeObserver((entries) => {
      updatePreviewWidth(entries[0]?.contentRect.width ?? node.clientWidth ?? PREVIEW_WIDTH);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [open]);

  const copyCardToClipboard = useCallback(async (): Promise<CopyResult> => {
    const node = cardRef.current;
    if (!node) {
      return "render-failed";
    }

    const blob = await renderNodeToPngBlob(node, CARD_EXPORT_SIZE);
    if (!blob) {
      return "render-failed";
    }

    return (await copyImageToClipboard(blob)) ? "copied" : "clipboard-unavailable";
  }, []);

  const handleCopy = useCallback(async () => {
    setBusy("copy");
    setStatus(null);
    try {
      const copyResult = await copyCardToClipboard();
      setStatus(copyStatusMessage(copyResult, t));
    } finally {
      setBusy(null);
    }
  }, [copyCardToClipboard, t]);

  const handleShare = useCallback(
    async (target: ShareTarget) => {
      setBusy(target);
      setStatus(null);
      try {
        const copyResult = await copyCardToClipboard();
        openExternalUrl(shareIntentUrl(target));
        setStatus(shareStatusMessage(copyResult, t));
      } finally {
        setBusy(null);
      }
    },
    [copyCardToClipboard, t],
  );

  const handleSave = useCallback(async () => {
    const node = cardRef.current;
    if (!node) {
      return;
    }
    setBusy("save");
    setStatus(null);
    try {
      const blob = await renderNodeToPngBlob(node, CARD_EXPORT_SIZE);
      if (blob) {
        downloadBlob(blob, `synara-stats-${stats.timezone.today}.png`);
        setStatus(t("profile.share.savedPng"));
      } else {
        setStatus(t("profile.share.renderFailed"));
      }
    } finally {
      setBusy(null);
    }
  }, [stats.timezone.today, t]);

  const previewScale = previewWidth / SHARE_CARD_WIDTH;
  const actionsDisabled = busy !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" className="sm:max-w-[560px]">
        <DialogTitle className="text-center text-xl">{t("profile.share.title")}</DialogTitle>
        <div className="mt-5 flex flex-col items-center gap-7 px-2 pb-3">
          <div
            ref={previewRef}
            className="w-full max-w-[480px] overflow-hidden rounded-2xl border bg-white shadow-sm"
            style={{ aspectRatio: `${SHARE_CARD_WIDTH} / ${SHARE_CARD_HEIGHT}` }}
          >
            <div
              style={{
                width: SHARE_CARD_WIDTH,
                transform: `scale(${previewScale})`,
                transformOrigin: "top left",
              }}
            >
              <ShareCard
                ref={cardRef}
                stats={stats}
                tokenStats={tokenStats}
                displayName={displayName}
                handle={handle}
                avatarColor={avatarColor}
                avatarImage={avatarImage}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-start justify-center gap-x-6 gap-y-4">
            <ShareButton
              label={t("profile.share.copy")}
              ariaLabel={t("profile.share.copyStatCard")}
              busy={busy === "copy"}
              disabled={actionsDisabled}
              onClick={() => void handleCopy()}
            >
              <CopyIcon className="size-5" />
            </ShareButton>
            <ShareButton
              label="X"
              busy={busy === "x"}
              disabled={actionsDisabled}
              onClick={() => void handleShare("x")}
            >
              <SiX className="size-5" />
            </ShareButton>
            <ShareButton
              label="LinkedIn"
              busy={busy === "linkedin"}
              disabled={actionsDisabled}
              onClick={() => void handleShare("linkedin")}
            >
              <FaLinkedinIn className="size-5" />
            </ShareButton>
            <ShareButton
              label="Reddit"
              busy={busy === "reddit"}
              disabled={actionsDisabled}
              onClick={() => void handleShare("reddit")}
            >
              <SiReddit className="size-5" />
            </ShareButton>
            <ShareButton
              label={t("profile.share.save")}
              ariaLabel={t("profile.share.saveStatCard")}
              busy={busy === "save"}
              disabled={actionsDisabled}
              onClick={() => void handleSave()}
            >
              <DownloadIcon className="size-5" />
            </ShareButton>
          </div>

          <p className="min-h-4 text-center text-xs leading-snug text-muted-foreground">
            {status ?? ""}
          </p>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function copyStatusMessage(result: CopyResult, t: (key: string) => string): string {
  switch (result) {
    case "copied":
      return t("profile.share.shareImageCopied");
    case "render-failed":
      return t("profile.share.renderFailed");
    case "clipboard-unavailable":
      return t("profile.share.copyUnavailable");
  }
}

function shareStatusMessage(result: CopyResult, t: (key: string) => string): string {
  switch (result) {
    case "copied":
      return t("profile.share.shareImageCopied");
    case "render-failed":
      return t("profile.share.composerOpenedRenderFailed");
    case "clipboard-unavailable":
      return t("profile.share.composerOpenedCopyUnavailable");
  }
}

interface ShareButtonProps {
  readonly label: string;
  readonly ariaLabel?: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function ShareButton({ label, ariaLabel, busy, disabled, onClick, children }: ShareButtonProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel ?? t("profile.share.shareTo", { label })}
        className={cn(
          "flex size-14 items-center justify-center rounded-full bg-foreground text-background transition-opacity",
          disabled ? (busy ? "opacity-70" : "opacity-35") : "hover:opacity-90",
        )}
      >
        {children}
      </button>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
