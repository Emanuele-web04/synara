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
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";

import { DownloadIcon, Loader2Icon, Maximize2 } from "~/lib/icons";
import type { ProjectCreateLocalFilePreviewGrantResult } from "@synara/contracts";
import { buildLocalImageUrl, normalizeMarkdownImagePath } from "~/lib/localImageUrls";
import { toAttachmentPreviewUrl } from "~/lib/wsHttpUrl";
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
  threadId?: string | null | undefined;
  attachmentId?: string | undefined;
  isLinked?: boolean;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function stopPropagation(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

export function GeneratedMarkdownImage(props: GeneratedMarkdownImageProps) {
  // An explicit retry resets failed/granted state and resolves a fresh owner-scoped handle.
  const [retryRevision, setRetryRevision] = useState(0);
  return (
    <GeneratedMarkdownImageContent
      key={JSON.stringify([
        props.src,
        props.cwd,
        props.threadId,
        props.attachmentId,
        retryRevision,
      ])}
      {...props}
      cacheKey={retryRevision || undefined}
      onRetry={() => setRetryRevision((revision) => revision + 1)}
    />
  );
}

function GeneratedMarkdownImageContent(
  props: GeneratedMarkdownImageProps & {
    cacheKey: number | undefined;
    onRetry: () => void;
  },
) {
  const { src, alt, cwd, onImageExpand } = props;
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Managed attachments retain their opaque host-bound URL; never send them through local-file RPCs.
  const resourceUrl = useMemo(
    () =>
      props.attachmentId
        ? toAttachmentPreviewUrl(`/attachments/${encodeURIComponent(props.attachmentId)}`)
        : undefined,
    [props.attachmentId],
  );
  const sourcePath = resourceUrl ? null : normalizeMarkdownImagePath(src);
  const [needsGrant, setNeedsGrant] = useState(false);
  const [previewGrant, setPreviewGrant] = useState<ProjectCreateLocalFilePreviewGrantResult>();
  const grantOptions = projectLocalPreviewGrantQueryOptions({
    path: sourcePath,
    cwd,
    threadId: props.threadId,
    enabled: needsGrant && sourcePath !== null && previewGrant === undefined,
    // An HTTP denial must not reuse a token invalidated by a server restart.
    staleTime: 0,
  });
  const retryGrant = (failureCount: number, error: unknown) =>
    failureCount < 2 &&
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === true;
  const grantQuery = useQuery({
    ...grantOptions,
    retry: retryGrant,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (
      needsGrant &&
      previewGrant === undefined &&
      !grantQuery.isFetching &&
      grantQuery.isSuccess &&
      isLocalPreviewGrantUsable(grantQuery.data)
    ) {
      // Freeze the loaded preview. Another file pane may renew the same cache
      // entry; that must not make historical chat images download again.
      setPreviewGrant(grantQuery.data);
    }
  }, [needsGrant, previewGrant, grantQuery.data, grantQuery.isFetching, grantQuery.isSuccess]);
  const { previewUrl, downloadUrl, fileName, downloadName, status, imgProps } =
    useLocalImagePreview({
      src,
      cwd,
      canonicalPath: previewGrant?.canonicalPath,
      resourceUrl,
      cacheKey: props.cacheKey,
      previewGrant: previewGrant?.grant,
      // Relative worktree references and absolute captures use the same bounded per-file recovery.
      onPreviewError: () => {
        if (sourcePath !== null) setNeedsGrant(true);
      },
    });
  const resolvingGrant =
    needsGrant &&
    !previewGrant &&
    (grantQuery.isFetching || (grantQuery.isSuccess && isLocalPreviewGrantUsable(grantQuery.data)));
  const resolveGrantedUrl = async (download: boolean) => {
    if (resourceUrl || !needsGrant || sourcePath === null)
      return download ? downloadUrl : previewUrl;
    // A backgrounded chat can outlive the grant TTL. Renew at the point of use.
    const grant = await queryClient.fetchQuery({ ...grantOptions, retry: retryGrant });
    return buildLocalImageUrl({
      src,
      cwd,
      canonicalPath: grant.canonicalPath,
      download,
      grant: grant.grant,
    });
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

  // The enclosing Markdown link owns activation; keep grant recovery but avoid
  // nesting expansion/download controls inside that link, including on errors.
  if (props.isLinked) {
    return (
      <span className="chat-generated-image">
        <img {...imgProps} alt={accessibleName} className="chat-generated-image__img" />
      </span>
    );
  }

  if (status === "error" && !resolvingGrant) {
    return (
      <LocalImageErrorCard
        downloadUrl={downloadUrl}
        downloadName={downloadName}
        className="local-image-error--prose"
        downloadAriaLabel="Download generated image"
        onDownloadClick={downloadImage}
        onRetry={props.onRetry}
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
