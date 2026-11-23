// FILE: browserDownload.ts
// Purpose: Browser-side file download helpers that keep failed downloads inside the app.
// Layer: Web utility
// Exports: downloadBlob, downloadUrlAsBlob, downloadVideoUrl
// Depends on: DOM anchor downloads and Fetch.

import { fetchExecutionResourceUrl, isDesktopFrameResourceUrl } from "./wsHttpUrl";

function clickDownloadLink(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.trim() || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    clickDownloadLink(url, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MAX_ERROR_DETAIL_CHARS = 300;

// Routes like /api/thread-export return a human-readable reason in the body
// (e.g. 409 while a turn is running); surface it instead of the bare status.
async function downloadResponseError(response: Response): Promise<Error> {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  let detail = "";
  try {
    detail = (await response.text()).trim();
  } catch {
    detail = "";
  }
  const suffix = detail.length > 0 && detail.length <= MAX_ERROR_DETAIL_CHARS ? ` ${detail}` : "";
  return new Error(`Download failed with HTTP ${response.status}${statusText}.${suffix}`);
}

function filenameFromContentDisposition(headerValue: string | null): string | null {
  if (!headerValue) return null;

  const match = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(headerValue);
  const filename = (match?.[1] ?? match?.[2] ?? "").trim();
  return filename.length > 0 ? filename : null;
}

// Fetches a local artifact before saving it so server 404/auth errors cannot
// navigate the main Electron renderer away from the app.
export async function downloadUrlAsBlob(input: {
  readonly url: string;
  readonly filename: string;
}): Promise<void> {
  const response = await fetchExecutionResourceUrl(input.url);
  if (!response.ok) {
    throw await downloadResponseError(response);
  }
  const filename = filenameFromContentDisposition(response.headers.get("Content-Disposition"));
  downloadBlob(await response.blob(), filename ?? input.filename);
}

// Desktop-frame resource URLs must be fetched through their owning controller.
// Bound the temporary Blob where native browser attachment downloads cannot be used.
export const VIDEO_DOWNLOAD_BLOB_LIMIT_MIB = 64;
const VIDEO_DOWNLOAD_BLOB_LIMIT_BYTES = VIDEO_DOWNLOAD_BLOB_LIMIT_MIB * 1024 * 1024;

export async function downloadVideoUrl(input: {
  readonly url: string;
  readonly filename: string;
  readonly tooLargeMessage: string;
}): Promise<void> {
  const response = await fetchExecutionResourceUrl(input.url);
  const body = response.body;
  if (!response.ok) {
    await body?.cancel().catch(() => undefined);
    throw new Error(`Download failed with HTTP ${response.status}.`);
  }
  const filename =
    filenameFromContentDisposition(response.headers.get("Content-Disposition")) ?? input.filename;
  if (!window.desktopBridge && !isDesktopFrameResourceUrl(input.url)) {
    const url = new URL(input.url, window.location.href);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === window.location.origin
    ) {
      // Validate the scoped download first, then let the browser stream the
      // attachment to disk. The preflight response never becomes a Blob.
      await body?.cancel().catch(() => undefined);
      clickDownloadLink(url.href, filename);
      return;
    }
  }

  if (Number(response.headers.get("Content-Length")) > VIDEO_DOWNLOAD_BLOB_LIMIT_BYTES) {
    await body?.cancel().catch(() => undefined);
    throw new Error(input.tooLargeMessage);
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const reader = body?.getReader();
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        // Headers may be absent, inaccurate, or report compressed bytes.
        if (size > VIDEO_DOWNLOAD_BLOB_LIMIT_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error(input.tooLargeMessage);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  downloadBlob(new Blob(chunks, { type: response.headers.get("Content-Type") ?? "" }), filename);
}
