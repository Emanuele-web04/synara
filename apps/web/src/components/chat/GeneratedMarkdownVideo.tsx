// FILE: GeneratedMarkdownVideo.tsx
// Purpose: Plays local videos embedded in assistant markdown (`![demo](out/clip.mp4)`)
//          inline, with the same grant recovery and retry model as
//          `GeneratedMarkdownImage`.
// Layer: Web chat presentation component
// Exports: GeneratedMarkdownVideo
// Notes: Rendering lives in `LocalVideoPreview` (variant "inline"); this wrapper
//        only owns the chat-specific preview grant and Retry behaviour.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { buildLocalImageUrl, normalizeMarkdownImagePath } from "~/lib/localImageUrls";
import { projectLocalPreviewGrantQueryOptions } from "~/lib/projectReactQuery";

import { LocalVideoPreview } from "../LocalVideoPreview";

export interface GeneratedMarkdownVideoProps {
  src: string;
  alt: string;
  cwd: string | undefined;
  threadId?: string | null | undefined;
  isLinked?: boolean;
}

export function GeneratedMarkdownVideo(props: GeneratedMarkdownVideoProps) {
  // An explicit retry resets the failed/granted state and reloads the file.
  const [retryRevision, setRetryRevision] = useState(0);
  return (
    <GeneratedMarkdownVideoContent
      key={JSON.stringify([props.src, props.cwd, props.threadId, retryRevision])}
      {...props}
      cacheKey={retryRevision || undefined}
      onRetry={() => setRetryRevision((revision) => revision + 1)}
    />
  );
}

function GeneratedMarkdownVideoContent(
  props: GeneratedMarkdownVideoProps & {
    cacheKey: number | undefined;
    onRetry: () => void;
  },
) {
  const { src, cwd } = props;
  const queryClient = useQueryClient();
  // Files outside the workspace and temp roots need a short-lived preview
  // grant. Playback requests one only after the ungranted URL fails, and renews
  // it at the point of use: a long video can outlive the grant before a later seek.
  const resolveGrantedUrl = async (download: boolean) => {
    const grant = await queryClient.fetchQuery(
      projectLocalPreviewGrantQueryOptions({
        path: normalizeMarkdownImagePath(src),
        cwd,
        threadId: props.threadId,
        // An HTTP denial must not reuse a token invalidated by a server restart.
        staleTime: 0,
      }),
    );
    return buildLocalImageUrl({
      src,
      cwd,
      canonicalPath: grant.canonicalPath,
      grant: grant.grant,
      download,
      ...(download ? {} : { cacheKey: props.cacheKey }),
    });
  };

  return (
    <LocalVideoPreview
      variant="inline"
      src={src}
      cwd={cwd}
      cacheKey={props.cacheKey}
      label={props.alt}
      isLinked={props.isLinked}
      resolveRecoveryUrl={() => resolveGrantedUrl(false)}
      // A download cannot rely on a playback failure to learn that the file
      // needs a grant: hosts that cannot stream never load the video at all.
      // Ask for a grant up front and keep the plain URL when none is issued.
      resolveDownloadUrl={() =>
        resolveGrantedUrl(true).catch(() => buildLocalImageUrl({ src, cwd, download: true }))
      }
      onRetry={props.onRetry}
    />
  );
}
