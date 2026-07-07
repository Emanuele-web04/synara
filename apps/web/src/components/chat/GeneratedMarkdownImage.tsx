// FILE: GeneratedMarkdownImage.tsx
// Purpose: Renders Codex-generated images embedded in assistant markdown with
//          loading skeleton, hover overlay (expand/download), and inline error card.
// Layer: Web chat presentation component
// Exports: GeneratedMarkdownImage
// Notes: Pure UI; loading state and the error card are shared with the editor
//        previews via `~/components/LocalImagePreview`. The image frame uses raw
//        <button> because it wires into class-based stylesheet selectors
//        (`chat-generated-image__*`) rather than shadcn Button.

import { type MouseEvent, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { DownloadIcon, Loader2Icon, Maximize2 } from "~/lib/icons";

import {
  LocalImageErrorCard,
  useLocalImageDownloadClick,
  useLocalImagePreview,
} from "../LocalImagePreview";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export interface GeneratedMarkdownImageProps {
  src: string;
  alt: string;
  cwd: string | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

export function GeneratedMarkdownImage(props: GeneratedMarkdownImageProps) {
  const { src, alt, cwd, onImageExpand } = props;
  const { t } = useTranslation();
  const { previewUrl, downloadUrl, fileName, downloadName, status, imgProps } =
    useLocalImagePreview({ src, cwd });
  const accessibleName = alt?.trim() || t("chat.generatedImage.generatedImage");
  const downloadImage = useLocalImageDownloadClick({
    downloadUrl,
    downloadName,
    errorTitle: t("chat.generatedImage.couldNotDownload"),
    t,
  });

  const expandImage = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      if (status === "error") {
        return;
      }
      onImageExpand?.({
        images: [{ src: previewUrl, name: fileName || accessibleName }],
        index: 0,
      });
    },
    [accessibleName, fileName, onImageExpand, previewUrl, status],
  );

  const stopPropagation = useCallback((event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  }, []);

  if (status === "error") {
    return (
      <LocalImageErrorCard
        downloadUrl={downloadUrl}
        downloadName={downloadName}
        className="local-image-error--prose"
        downloadAriaLabel={t("chat.generatedImage.downloadImage")}
        onDownloadClick={downloadImage}
      />
    );
  }

  return (
    <span className="chat-generated-image" data-status={status}>
      <button
        type="button"
        className="chat-generated-image__frame"
        onClick={expandImage}
        aria-label={t("chat.generatedImage.expandImage")}
      >
        {status === "loading" ? (
          <span className="chat-generated-image__skeleton" aria-hidden="true">
            <Loader2Icon className="size-4 animate-spin opacity-60" />
          </span>
        ) : null}
        <img {...imgProps} alt={accessibleName} className="chat-generated-image__img" />
        <span className="chat-generated-image__overlay" aria-hidden="true">
          <span className="chat-generated-image__overlay-pill chat-generated-image__overlay-pill--expand">
            <Maximize2 className="size-3.5" />
            <span>{t("chat.generatedImage.expand")}</span>
          </span>
        </span>
      </button>
      <a
        href={downloadUrl}
        download={downloadName}
        onClick={downloadImage}
        onMouseDown={stopPropagation}
        className="chat-generated-image__overlay-pill chat-generated-image__overlay-pill--download"
        aria-label={t("chat.generatedImage.downloadImage")}
        title={t("chat.generatedImage.download")}
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
        <span>{t("chat.generatedImage.download")}</span>
      </a>
    </span>
  );
}
