// FILE: LocalVideoPreview.tsx
// Purpose: Native <video> preview for local video files served by the
//          /api/local-image route, in the file preview pane ("panel") and inline
//          in chat markdown ("inline").
// Layer: Web UI primitive
// Exports: LocalVideoPreview
// Notes: The element points straight at the preview URL so playback streams
//        through HTTP Range requests; video bytes are never buffered into a Blob.
//        URL building, download handling and the error card are shared with
//        `LocalImagePreview`. Hosts proxied through the desktop frame cannot
//        stream, so they get the error card with a Download action instead.

import { type SyntheticEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useTranslation } from "~/i18n";
import { VIDEO_DOWNLOAD_BLOB_LIMIT_MIB, downloadVideoUrl } from "~/lib/browserDownload";
import { DownloadIcon, Loader2Icon } from "~/lib/icons";
import { buildLocalImageUrl, localImageFileName } from "~/lib/localImageUrls";
import { cn } from "~/lib/utils";
import { isDesktopFrameResourceUrl } from "~/lib/wsHttpUrl";
import { LocalImageErrorCard, useLocalImageDownloadClick } from "./LocalImagePreview";

type LocalVideoPreviewStatus = "loading" | "ready" | "error";

interface VideoLoad {
  url: string;
  /** Distinguishes separate loads so stale element events are ignored. */
  generation: number;
  status: LocalVideoPreviewStatus;
  /** Playback position to restore after swapping to a recovery URL. */
  resume: { time: number; playing: boolean } | null;
  /** This URL came from recovery and has not loaded yet; it never recovers again. */
  recovered: boolean;
}

export interface LocalVideoPreviewProps {
  src: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  canonicalPath?: string | undefined;
  cacheKey?: string | number | undefined;
  /** "panel" fills the file preview pane; "inline" reserves a fixed 16:9 box in chat prose. */
  variant?: "panel" | "inline";
  /** Accessible name for the player; defaults to the file name. */
  label?: string | undefined;
  className?: string | undefined;
  videoClassName?: string | undefined;
  /** Inline only: an enclosing markdown link owns activation, so no controls or actions. */
  isLinked?: boolean | undefined;
  /**
   * Called once when the element fails, before the error card is shown. A
   * different URL (for example one carrying a fresh preview grant) replaces the
   * failed one and, if playback had started, resumes at the same position.
   * Defaults to the URL built from the latest props.
   */
  resolveRecoveryUrl?: (() => Promise<string | null>) | undefined;
  resolveDownloadUrl?: (() => Promise<string>) | undefined;
  onRetry?: (() => void) | undefined;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: (() => void) | undefined;
}

export function LocalVideoPreview(props: LocalVideoPreviewProps) {
  const { t } = useTranslation();
  const variant = props.variant ?? "panel";
  const latestUrl = buildLocalImageUrl({
    src: props.src,
    cwd: props.cwd ?? undefined,
    canonicalPath: props.canonicalPath,
    grant: props.previewGrant,
    cacheKey: props.cacheKey,
  });
  const downloadUrl = buildLocalImageUrl({
    src: props.src,
    cwd: props.cwd ?? undefined,
    canonicalPath: props.canonicalPath,
    grant: props.previewGrant,
    download: true,
  });
  const fileName = localImageFileName(props.src);
  const downloadName = fileName || "";
  const latestUrlRef = useRef(latestUrl);
  useLayoutEffect(() => {
    latestUrlRef.current = latestUrl;
  }, [latestUrl]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Once the player has loaded, a refreshed URL (e.g. a renewed preview grant)
  // must not reload it and reset playback; it is only adopted through recovery
  // after the current URL actually fails. Before that, follow the latest URL.
  const [storedLoad, setStoredLoad] = useState<VideoLoad>(() => ({
    url: latestUrl,
    generation: 0,
    status: "loading",
    resume: null,
    recovered: false,
  }));
  const load =
    storedLoad.status === "loading" && !storedLoad.recovered && storedLoad.url !== latestUrl
      ? { ...storedLoad, url: latestUrl, generation: storedLoad.generation + 1 }
      : storedLoad;
  if (load !== storedLoad) {
    setStoredLoad(load);
  }
  const updateLoad = (generation: number, next: (current: VideoLoad) => VideoLoad) => {
    setStoredLoad((current) => (current.generation === generation ? next(current) : current));
  };

  const unsupportedHost = isDesktopFrameResourceUrl(load.url);
  const { onPreviewReady } = props;
  useEffect(() => {
    // Nothing will load on this host; settle the caller's loading state.
    if (unsupportedHost) onPreviewReady?.();
  }, [onPreviewReady, unsupportedHost]);

  const handleDownloadClick = useLocalImageDownloadClick({
    downloadUrl,
    downloadName,
    errorTitle: t("common:video_couldNotDownload"),
    resolveDownloadUrl: props.resolveDownloadUrl,
    download: (input) =>
      downloadVideoUrl({
        ...input,
        tooLargeMessage: t("common:video_downloadTooLarge", {
          maxMiB: VIDEO_DOWNLOAD_BLOB_LIMIT_MIB,
        }),
      }),
  });

  const isCurrentEvent = (event: SyntheticEvent<HTMLVideoElement>) =>
    event.currentTarget.getAttribute("src") === load.url;

  const handleLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (!isCurrentEvent(event)) return;
    const video = event.currentTarget;
    if (load.resume) {
      const { time, playing } = load.resume;
      video.currentTime = Number.isFinite(video.duration) ? Math.min(time, video.duration) : time;
      if (playing) void video.play().catch(() => undefined);
    }
    updateLoad(load.generation, (current) => ({
      ...current,
      status: "ready",
      resume: null,
      recovered: false,
    }));
    props.onPreviewReady?.();
  };

  const handleError = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (!isCurrentEvent(event)) return;
    const video = event.currentTarget;
    const failed = load;
    const fail = () => {
      if (!mounted.current) return;
      updateLoad(failed.generation, (current) => ({ ...current, status: "error", resume: null }));
      props.onPreviewError?.();
    };
    if (failed.recovered) {
      fail();
      return;
    }
    const resume =
      failed.resume ??
      (failed.status === "ready" ? { time: video.currentTime, playing: !video.paused } : null);
    const resolveRecoveryUrl =
      props.resolveRecoveryUrl ?? (() => Promise.resolve(latestUrlRef.current));
    void resolveRecoveryUrl()
      .catch(() => null)
      .then((url) => {
        if (!mounted.current) return;
        if (!url || url === failed.url) {
          fail();
          return;
        }
        updateLoad(failed.generation, (current) => ({
          url,
          generation: current.generation + 1,
          // A loaded player keeps its frame while it reconnects.
          status: current.status === "ready" ? "ready" : "loading",
          resume,
          recovered: true,
        }));
      });
  };

  const accessibleName = props.label?.trim() || fileName;
  const inline = variant === "inline";
  const errorCardClassName = cn(inline && "local-image-error--prose", props.className);

  // Inside a markdown link the card's download anchor would nest; keep the frame.
  if (!(inline && props.isLinked) && (unsupportedHost || load.status === "error")) {
    return (
      <LocalImageErrorCard
        downloadUrl={downloadUrl}
        downloadName={downloadName}
        className={errorCardClassName}
        title={
          unsupportedHost
            ? t("common:video_inlinePlaybackUnavailable")
            : t("common:video_couldNotPlay")
        }
        subtitle={
          unsupportedHost
            ? t("common:video_inlinePlaybackUnavailableDescription")
            : t("common:video_couldNotPlayDescription")
        }
        downloadAriaLabel={t("common:video_downloadVideo")}
        retryAriaLabel={t("common:video_retryPreview")}
        onDownloadClick={handleDownloadClick}
        onRetry={unsupportedHost ? undefined : props.onRetry}
      />
    );
  }

  // A linked frame on an unsupported host has nothing to wait for.
  const status = unsupportedHost ? "error" : load.status;
  const showControls = !(inline && props.isLinked);
  const video = (
    // This previews an arbitrary local file chosen by the user or an agent, so
    // there is no caption track to offer; the rule targets authored media.
    // oxlint-disable-next-line jsx-a11y/media-has-caption
    <video
      src={unsupportedHost ? undefined : load.url}
      controls={showControls}
      controlsList="nodownload"
      preload="metadata"
      playsInline
      aria-label={accessibleName}
      className={cn(
        inline ? "chat-generated-video__video" : "local-image-preview__img",
        props.videoClassName,
      )}
      onLoadedMetadata={handleLoadedMetadata}
      onError={handleError}
    />
  );
  const downloadAction = (
    <a
      href={downloadUrl}
      download={downloadName}
      onClick={handleDownloadClick}
      className={
        inline
          ? "chat-generated-image__overlay-pill chat-generated-image__overlay-pill--download"
          : "local-image-preview__download"
      }
      aria-label={t("common:video_downloadVideo")}
      title={t("common:image_download")}
    >
      <DownloadIcon className="size-3.5" aria-hidden="true" />
      {inline ? <span>{t("common:image_download")}</span> : null}
    </a>
  );

  if (inline) {
    // The frame's width and 16:9 box are fixed before metadata arrives, so the
    // transcript row never changes height when the video loads.
    return (
      <span
        className={cn("chat-generated-image chat-generated-video", props.className)}
        data-status={status}
      >
        <span className="chat-generated-video__frame">
          {status === "loading" ? (
            <span className="chat-generated-image__skeleton" aria-hidden="true">
              <Loader2Icon className="size-4 animate-spin opacity-60" />
            </span>
          ) : null}
          {video}
        </span>
        {props.isLinked ? null : downloadAction}
      </span>
    );
  }

  return (
    <div className={cn("local-image-preview", props.className)} data-status={status}>
      {status === "loading" ? (
        <span className="local-image-preview__skeleton" aria-hidden="true">
          <Loader2Icon className="size-4 animate-spin opacity-60" />
        </span>
      ) : null}
      {video}
      {downloadAction}
    </div>
  );
}
