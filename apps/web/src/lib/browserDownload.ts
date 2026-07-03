// FILE: browserDownload.ts
// Purpose: Browser-side file download helpers that keep failed downloads inside the app.
// Layer: Web utility
// Exports: downloadBlob, downloadUrlAsBlob
// Depends on: DOM anchor downloads and Fetch.

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.trim() || "download";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function downloadResponseError(response: Response): Error {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return new Error(`Download failed with HTTP ${response.status}${statusText}.`);
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
  const response = await fetch(input.url);
  if (!response.ok) {
    throw downloadResponseError(response);
  }
  const filename = filenameFromContentDisposition(response.headers.get("Content-Disposition"));
  downloadBlob(await response.blob(), filename ?? input.filename);
}
