// FILE: LocalImagePreview.tsx
// Purpose: Shared local-image preview surface for editor file and diff views.
// Layer: Web UI primitive

import { useEffect, useMemo, useState } from "react";

import { DownloadIcon, Loader2Icon, TriangleAlertIcon } from "~/lib/icons";
import { buildLocalImageUrl, localImageFileName } from "~/lib/localImageUrls";
import { cn } from "~/lib/utils";

type LocalImagePreviewStatus = "loading" | "ready" | "error";

export function LocalImagePreview(props: {
  src: string;
  cwd: string | null | undefined;
  alt: string;
  className?: string;
  imageClassName?: string;
}) {
  const { src, cwd } = props;
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

  if (status === "error") {
    return (
      <div className={cn("local-image-preview local-image-preview--error", props.className)}>
        <span className="local-image-preview__error-icon" aria-hidden="true">
          <TriangleAlertIcon className="size-4" />
        </span>
        <span className="local-image-preview__error-body">
          <span className="local-image-preview__error-title">Couldn’t open this image</span>
          <span className="local-image-preview__error-subtitle">
            The file may have moved or be unavailable.
          </span>
        </span>
        <a
          href={downloadUrl}
          download={fileName || ""}
          className="local-image-preview__action"
          aria-label="Download image"
        >
          <DownloadIcon className="size-3.5" aria-hidden="true" />
          <span>Download</span>
        </a>
      </div>
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
        src={previewUrl}
        alt={props.alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("error")}
        className={cn("local-image-preview__img", props.imageClassName)}
      />
      <a
        href={downloadUrl}
        download={fileName || ""}
        className="local-image-preview__download"
        aria-label="Download image"
        title="Download"
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
