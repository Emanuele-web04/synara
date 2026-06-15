// FILE: LocalImagePreview.tsx
// Purpose: Shared local-image loading state and error card, plus the panel
//          preview surface used by editor file and diff views.
// Layer: Web UI primitive
// Exports: useLocalImagePreview, LocalImageErrorCard, LocalImagePreview
// Notes: Pure UI; image URL building lives in `~/lib/localImageUrls`. The chat
//        markdown variant (`GeneratedMarkdownImage`) composes the same hook and
//        error card with its own inline frame/overlay rendering.

import { type ImgHTMLAttributes, type MouseEvent, useEffect, useMemo, useState } from "react";

import { DownloadIcon, Loader2Icon, TriangleAlertIcon } from "~/lib/icons";
import { buildLocalImageUrl, localImageFileName } from "~/lib/localImageUrls";
import { cn } from "~/lib/utils";

export type LocalImagePreviewStatus = "loading" | "ready" | "error";

type LocalImagePreviewImgProps = Pick<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "loading" | "decoding" | "draggable" | "onLoad" | "onError"
>;

export interface LocalImagePreviewState {
  previewUrl: string;
  downloadUrl: string;
  fileName: string;
  /** Value for `<a download>`: it needs a string, and an empty string still
      hints the browser to download instead of navigating. */
  downloadName: string;
  status: LocalImagePreviewStatus;
  imgProps: LocalImagePreviewImgProps;
}

export function useLocalImagePreview(input: {
  src: string;
  cwd: string | null | undefined;
}): LocalImagePreviewState {
  const { src, cwd } = input;
  const previewUrl = useMemo(() => buildLocalImageUrl({ src, cwd: cwd ?? undefined }), [cwd, src]);
  const downloadUrl = useMemo(
    () => buildLocalImageUrl({ src, cwd: cwd ?? undefined, download: true }),
    [cwd, src],
  );
  const fileName = useMemo(() => localImageFileName(src), [src]);
  const [status, setStatus] = useState<LocalImagePreviewStatus>("loading");

  useEffect(() => {
    setStatus("loading");
  }, [previewUrl]);

  const imgProps = useMemo<LocalImagePreviewImgProps>(
    () => ({
      src: previewUrl,
      loading: "lazy",
      decoding: "async",
      draggable: false,
      onLoad: () => setStatus("ready"),
      onError: () => setStatus("error"),
    }),
    [previewUrl],
  );

  return { previewUrl, downloadUrl, fileName, downloadName: fileName || "", status, imgProps };
}

// Span-only markup so the card stays valid inside markdown paragraphs.
export function LocalImageErrorCard(props: {
  downloadUrl: string;
  /** `downloadName` from useLocalImagePreview. */
  downloadName: string;
  className?: string | undefined;
  downloadAriaLabel?: string;
  onDownloadClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
}) {
  return (
    <span className={cn("local-image-error", props.className)}>
      <span className="local-image-error__icon" aria-hidden="true">
        <TriangleAlertIcon className="size-4" />
      </span>
      <span className="local-image-error__body">
        <span className="local-image-error__title">Couldn’t open this image</span>
        <span className="local-image-error__subtitle">
          The file may have moved or be unavailable.
        </span>
      </span>
      <a
        href={props.downloadUrl}
        download={props.downloadName}
        onClick={props.onDownloadClick}
        className="local-image-error__action"
        aria-label={props.downloadAriaLabel ?? "Download image"}
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
        <span>Download</span>
      </a>
    </span>
  );
}

export function LocalImagePreview(props: {
  src: string;
  cwd: string | null | undefined;
  alt: string;
  className?: string;
  imageClassName?: string;
}) {
  const { downloadUrl, downloadName, status, imgProps } = useLocalImagePreview({
    src: props.src,
    cwd: props.cwd,
  });

  if (status === "error") {
    return (
      <LocalImageErrorCard
        downloadUrl={downloadUrl}
        downloadName={downloadName}
        className={props.className}
      />
    );
  }

  return (
    <div className={cn("local-image-preview", props.className)} data-status={status}>
      {status === "loading" ? (
        <span className="local-image-preview__skeleton" aria-hidden="true">
          <Loader2Icon className="size-4 animate-spin opacity-60" />
        </span>
      ) : null}
      <img
        {...imgProps}
        alt={props.alt}
        className={cn("local-image-preview__img", props.imageClassName)}
      />
      <a
        href={downloadUrl}
        download={downloadName}
        className="local-image-preview__download"
        aria-label="Download image"
        title="Download"
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
