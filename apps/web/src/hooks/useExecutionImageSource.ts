import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@synara/contracts";
import { type SyntheticEvent, useEffect, useState } from "react";

import { fetchExecutionImageResourceUrl, isDesktopFrameResourceUrl } from "~/lib/wsHttpUrl";

/** Preview endpoints can stream workspace files, so bound bytes before making a blob URL. */
export async function readExecutionImageBlob(
  response: Response,
  signal: AbortSignal,
): Promise<Blob> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Could not load image preview.");
  }
  const mimeType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType?.startsWith("image/")) {
    await response.body?.cancel();
    throw new Error("This resource is not an image preview.");
  }
  const declaredSize = response.headers.get("Content-Length");
  if (declaredSize && Number(declaredSize) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Image preview exceeds the permitted size.");
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const reader = response.body?.getReader();
  let size = 0;
  let completed = false;
  if (reader) {
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }
        size += value.byteLength;
        if (size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new Error("Image preview exceeds the permitted size.");
        }
        chunks.push(new Uint8Array(value));
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
  return new Blob(chunks, { type: mimeType });
}

/** Remote desktop frames receive only image bytes; the controller retains the native broker. */
export function useExecutionImageSource(source: string | undefined, lazy = true) {
  const proxied = isDesktopFrameResourceUrl(source);
  const [element, setElement] = useState<HTMLImageElement | null>(null);
  const [visibility, setVisibility] = useState({ source, visible: false, visit: 0 });
  const [dimensions, setDimensions] = useState<{
    source: string | undefined;
    width: number;
    height: number;
  } | null>(null);
  const [loaded, setLoaded] = useState<{
    source: string | undefined;
    visit: number;
    url?: string;
    error?: boolean;
  }>(() => ({ source, visit: 0 }));
  if (loaded.source !== source) setLoaded({ source, visit: 0 });
  const visible = !lazy || (visibility.source === source && visibility.visible);
  const visit = lazy ? visibility.visit : 0;

  useEffect(() => {
    if (!proxied || !source || !lazy || !element) return;
    const updateVisibility = (visible: boolean) =>
      setVisibility((current) =>
        current.source === source && current.visible === visible
          ? current
          : { source, visible, visit: current.visit + (visible ? 1 : 0) },
      );
    if (typeof IntersectionObserver === "undefined") {
      updateVisibility(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        updateVisibility(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, lazy, proxied, source]);

  useEffect(() => {
    if (!proxied || !source || !visible) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void fetchExecutionImageResourceUrl(source, { signal: controller.signal })
      .then((response) => readExecutionImageBlob(response, controller.signal))
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ source, visit, url: objectUrl });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoaded({ source, visit, error: true });
          controller.abort();
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [proxied, source, visible, visit]);

  const current = loaded.source === source && loaded.visit === visit ? loaded : null;
  const intrinsicSize = dimensions?.source === source ? dimensions : null;
  // An img without src loses its intrinsic ratio in Chromium. This empty vector keeps
  // layout stable without retaining the decoded photograph or an object URL offscreen.
  const placeholder = intrinsicSize
    ? `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${intrinsicSize.width}" height="${intrinsicSize.height}"/>`)}`
    : undefined;
  return {
    ref: proxied ? setElement : undefined,
    src: proxied ? ((visible ? current?.url : undefined) ?? placeholder) : source,
    error: proxied && current?.error === true,
    // Preserve the decoded image's intrinsic geometry when offscreen bytes are released.
    intrinsicProps: intrinsicSize
      ? {
          width: intrinsicSize.width,
          height: intrinsicSize.height,
          style: {
            height: "auto",
            aspectRatio: `${intrinsicSize.width} / ${intrinsicSize.height}`,
          },
        }
      : {},
    onLoad: (event: SyntheticEvent<HTMLImageElement>) => {
      if (
        proxied &&
        (!visible || !current?.url || event.currentTarget.getAttribute("src") !== current.url)
      )
        return false;
      const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
      if (proxied && width > 0 && height > 0)
        setDimensions((current) =>
          current !== null &&
          current.source === source &&
          current.width === width &&
          current.height === height
            ? current
            : { source, width, height },
        );
      return true;
    },
  };
}
