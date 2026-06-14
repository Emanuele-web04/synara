// FILE: ShareDialog.tsx
// Purpose: "Share your activity" dialog — previews the virality card and exports it to
// PNG fully on-device, then copies to clipboard + opens a social composer, or saves the
// file. Mirrors the reference share sheet (X / LinkedIn / Reddit / Save).
// Layer: web profile feature.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SiReddit, SiX } from "react-icons/si";
import { FaLinkedinIn } from "react-icons/fa6";
import type { ProfileStats, ProfileTokenStats } from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { DownloadIcon } from "~/lib/icons";
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
  const [busy, setBusy] = useState<ShareTarget | "save" | null>(null);
  const [previewWidth, setPreviewWidth] = useState(PREVIEW_WIDTH);
  const [status, setStatus] = useState<string | null>(null);

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

  const handleShare = useCallback(async (target: ShareTarget) => {
    const node = cardRef.current;
    if (!node) {
      return;
    }
    setBusy(target);
    setStatus(null);
    try {
      const blob = await renderNodeToPngBlob(node, CARD_EXPORT_SIZE);
      const copied = blob ? await copyImageToClipboard(blob) : false;
      openExternalUrl(shareIntentUrl(target));
      setStatus(
        copied
          ? "Image copied to clipboard — paste it into your post."
          : "Composer opened — use Save to attach the image.",
      );
    } finally {
      setBusy(null);
    }
  }, []);

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
        setStatus("Saved PNG to your downloads.");
      } else {
        setStatus("Could not render the image.");
      }
    } finally {
      setBusy(null);
    }
  }, [stats.timezone.today]);

  const previewScale = previewWidth / SHARE_CARD_WIDTH;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" className="sm:max-w-[560px]">
        <DialogTitle className="text-center text-xl">Share your activity</DialogTitle>
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

          <div className="flex items-start justify-center gap-6">
            <ShareButton label="X" busy={busy === "x"} onClick={() => void handleShare("x")}>
              <SiX className="size-5" />
            </ShareButton>
            <ShareButton
              label="LinkedIn"
              busy={busy === "linkedin"}
              onClick={() => void handleShare("linkedin")}
            >
              <FaLinkedinIn className="size-5" />
            </ShareButton>
            <ShareButton
              label="Reddit"
              busy={busy === "reddit"}
              onClick={() => void handleShare("reddit")}
            >
              <SiReddit className="size-5" />
            </ShareButton>
            <ShareButton label="Save" busy={busy === "save"} onClick={() => void handleSave()}>
              <DownloadIcon className="size-5" />
            </ShareButton>
          </div>

          <p className="h-4 text-center text-xs text-muted-foreground">{status ?? ""}</p>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

interface ShareButtonProps {
  readonly label: string;
  readonly busy: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function ShareButton({ label, busy, onClick, children }: ShareButtonProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label={`Share to ${label}`}
        className={cn(
          "flex size-14 items-center justify-center rounded-full bg-foreground text-background transition-opacity",
          "hover:opacity-90 disabled:opacity-50",
        )}
      >
        {children}
      </button>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
