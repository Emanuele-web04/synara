// FILE: GeneratedMarkdownImage.tsx
// Purpose: Renders Codex-generated images embedded in assistant markdown with
//          loading skeleton, hover overlay (expand/download), and inline error card.
// Layer: Web chat presentation component
// Exports: GeneratedMarkdownImage
// Notes: Pure UI; loading state and the error card are shared with the editor
//        previews via `~/components/LocalImagePreview`. The image frame uses raw
//        <button> because it wires into class-based stylesheet selectors
//        (`chat-generated-image__*`) rather than shadcn Button.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useEffect, useRef, useState } from "react";

import { DownloadIcon, Loader2Icon, Maximize2 } from "~/lib/icons";
import { buildLocalImageUrl, localImageAbsolutePath } from "~/lib/localImageUrls";
import {
  isLocalPreviewGrantUsable,
  projectLocalPreviewGrantQueryOptions,
} from "~/lib/projectReactQuery";

import {
  LocalImageErrorCard,
  useLocalImageDownloadClick,
  useLocalImagePreview,
} from "../LocalImagePreview";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { toastManager } from "../ui/toast";

export interface GeneratedMarkdownImageProps {
  src: string;
  alt: string;
  cwd: string | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function stopPropagation(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

export function GeneratedMarkdownImage(props: GeneratedMarkdownImageProps) {
  // Reset grant recovery when the source or workspace changes, including A → B → A.
  return <GeneratedMarkdownImageContent key={JSON.stringify([props.src, props.cwd])} {...props} />;
}

function GeneratedMarkdownImageContent(props: GeneratedMarkdownImageProps) {
  const { src, alt, cwd, onImageExpand } = props;
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const absolutePath = localImageAbsolutePath(src);
  const [needsGrant, setNeedsGrant] = useState(false);
  const grantOptions = projectLocalPreviewGrantQueryOptions({
    path: absolutePath,
    enabled: needsGrant && absolutePath !== null,
  });
  const grantQuery = useQuery({ ...grantOptions, retry: false });
  const previewGrant =
    needsGrant && isLocalPreviewGrantUsable(grantQuery.data) ? grantQuery.data?.grant : undefined;
  const { previewUrl, downloadUrl, fileName, downloadName, status, imgProps } =
    useLocalImagePreview({
      src,
      cwd,
      previewGrant,
      // Desktop/Downloads captures need the same per-file grant as the file pane.
      // Keep workspace and temporary images on the existing HTTP-only fast path.
      onPreviewError: () => {
        if (absolutePath !== null) setNeedsGrant(true);
      },
    });
  const resolvingGrant = needsGrant && grantQuery.isFetching && !previewGrant;
  const resolveGrantedUrl = async (download: boolean) => {
    if (!needsGrant || absolutePath === null) return download ? downloadUrl : previewUrl;
    // A backgrounded chat can outlive the grant TTL. Renew at the point of use.
    const grant = await queryClient.fetchQuery({ ...grantOptions, staleTime: 0, retry: false });
    return buildLocalImageUrl({ src, cwd, download, grant: grant.grant });
  };
  const accessibleName = alt?.trim() || "Generated image";
  const downloadImage = useLocalImageDownloadClick({
    downloadUrl,
    downloadName,
    errorTitle: "Could not download generated image",
    resolveDownloadUrl: () => resolveGrantedUrl(true),
  });

  const expandImage = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (status === "error") {
      return;
    }
    if (!onImageExpand) return;
    if (!needsGrant) {
      onImageExpand({ images: [{ src: previewUrl, name: fileName || accessibleName }], index: 0 });
      return;
    }
    void resolveGrantedUrl(false)
      .then((url) => {
        if (mounted.current) {
          onImageExpand({ images: [{ src: url, name: fileName || accessibleName }], index: 0 });
        }
      })
      .catch((error: unknown) => {
        if (mounted.current) {
          toastManager.add({
            type: "error",
            title: "Could not open generated image",
            description: error instanceof Error ? error.message : "The file may be unavailable.",
          });
        }
      });
  };

  if (status === "error" && !resolvingGrant) {
    return (
      <LocalImageErrorCard
        downloadUrl={downloadUrl}
        downloadName={downloadName}
        className="local-image-error--prose"
        downloadAriaLabel="Download generated image"
        onDownloadClick={downloadImage}
      />
    );
  }

  return (
    <span className="chat-generated-image" data-status={resolvingGrant ? "loading" : status}>
      <button
        type="button"
        className="chat-generated-image__frame"
        onClick={expandImage}
        aria-label="Expand generated image"
      >
        {status === "loading" || resolvingGrant ? (
          <span className="chat-generated-image__skeleton" aria-hidden="true">
            <Loader2Icon className="size-4 animate-spin opacity-60" />
          </span>
        ) : null}
        <img {...imgProps} alt={accessibleName} className="chat-generated-image__img" />
        <span className="chat-generated-image__overlay" aria-hidden="true">
          <span className="chat-generated-image__overlay-pill chat-generated-image__overlay-pill--expand">
            <Maximize2 className="size-3.5" />
            <span>Expand</span>
          </span>
        </span>
      </button>
      <a
        href={downloadUrl}
        download={downloadName}
        onClick={downloadImage}
        onMouseDown={stopPropagation}
        className="chat-generated-image__overlay-pill chat-generated-image__overlay-pill--download"
        aria-label="Download generated image"
        title="Download"
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
        <span>Download</span>
      </a>
    </span>
  );
}
