// FILE: canvasAssets.ts
// Purpose: Work assets arrive as metadata; their bytes load once per content hash through
//          `canvas.getAsset`, then become blob URLs (images) or registered faces (fonts).
// Layer: Canvas data
// Exports: loadCanvasAsset, loadCanvasAssets, useCanvasAssetUrls, useCanvasFonts,
//          useCanvasPreviewContext

import type { CanvasAsset } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  acquireAssetUrl,
  designFontMap,
  isDesignFontRegistered,
  registerDesignFont,
  releaseAssetUrl,
  type DesignRenderContext,
  type LoadedCanvasAsset,
} from "~/lib/designCanvas";
import { ensureNativeApi } from "~/nativeApi";

/** Base64 bytes by SHA-256. Content-addressed, so an entry never goes stale. */
const loaded = new Map<string, { data: Promise<string>; bytes: number }>();
const MAX_CACHED_BYTES = 64 * 1024 * 1024;

function evict() {
  let total = 0;
  for (const entry of loaded.values()) total += entry.bytes;
  for (const [hash, entry] of loaded) {
    if (total <= MAX_CACHED_BYTES) break;
    loaded.delete(hash);
    total -= entry.bytes;
  }
}

/** One asset's bytes, fetched once per content hash and shared by every work that has it. */
export function loadCanvasAsset(workId: string, asset: CanvasAsset): Promise<LoadedCanvasAsset> {
  let entry = loaded.get(asset.sha256);
  if (entry) {
    // Most recently used last, so eviction drops the oldest.
    loaded.delete(asset.sha256);
  } else {
    const data = ensureNativeApi()
      .canvas.getAsset({ workId, assetId: asset.id })
      .then((result) => {
        if (result.sha256 !== asset.sha256) throw new Error("Canvas asset changed.");
        return result.data;
      });
    entry = { data, bytes: asset.sizeBytes };
    const current = entry;
    data.catch(() => {
      if (loaded.get(asset.sha256) === current) loaded.delete(asset.sha256);
    });
  }
  loaded.set(asset.sha256, entry);
  evict();
  return entry.data.then((data) => ({ ...asset, data }));
}

/** Every asset that could be loaded; a missing one renders as absent, as before. */
export async function loadCanvasAssets(
  workId: string,
  assets: readonly CanvasAsset[] | undefined,
): Promise<LoadedCanvasAsset[]> {
  const settled = await Promise.allSettled(
    (assets ?? []).map((asset) => loadCanvasAsset(workId, asset)),
  );
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

/** Blob URLs for a work's images; the resolver changes once the images have loaded. */
export function useCanvasAssetUrls(workId: string, assets: readonly CanvasAsset[] | undefined) {
  const images = useMemo(
    () => (assets ?? []).filter((asset) => asset.mimeType !== "font/woff2"),
    [assets],
  );
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    let active = true;
    const acquired: CanvasAsset[] = [];
    void loadCanvasAssets(workId, images).then((ready) => {
      if (!active) return;
      const next = new Map<string, string>();
      for (const asset of ready) {
        next.set(asset.id, acquireAssetUrl(asset));
        acquired.push(asset);
      }
      // An unchanged set keeps the resolver, so frames are not rewritten for nothing.
      setUrls((current) =>
        current.size === next.size && [...next].every(([id, url]) => current.get(id) === url)
          ? current
          : next,
      );
    });
    return () => {
      active = false;
      acquired.forEach(releaseAssetUrl);
    };
  }, [images, workId]);
  return useMemo(() => (id: string) => urls.get(id) ?? null, [urls]);
}

/** The design-name mapping of a work's fonts; each face registers once its bytes arrive. */
export function useCanvasFonts(workId: string, assets: readonly CanvasAsset[] | undefined) {
  const fonts = useMemo(() => designFontMap(assets ?? []), [assets]);
  useEffect(() => {
    for (const asset of assets ?? [])
      if (asset.mimeType === "font/woff2" && !isDesignFontRegistered(asset))
        void loadCanvasAsset(workId, asset).then(registerDesignFont, () => {
          /* A font that cannot load falls back to the next family in the stack. */
        });
  }, [assets, workId]);
  return fonts;
}

/**
 * What a thumbnail outside the editor (a chat turn card) needs to draw a work's frames as the
 * canvas does: its fonts registered and named, its images as URLs.
 */
export function useCanvasPreviewContext(
  workId: string,
  assets: readonly CanvasAsset[] | undefined,
): DesignRenderContext {
  const fonts = useCanvasFonts(workId, assets);
  const assetUrl = useCanvasAssetUrls(workId, assets);
  return useMemo(() => ({ fonts, assetUrl }), [assetUrl, fonts]);
}
