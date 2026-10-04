import path from "node:path";
import Mime from "@effect/platform-node/Mime";

const PROJECT_ICON_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/** Restrict project assets to the supported image formats when resolving and serving. */
export function getProjectIconContentType(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  return Object.hasOwn(PROJECT_ICON_CONTENT_TYPES, extension)
    ? PROJECT_ICON_CONTENT_TYPES[extension]!
    : null;
}

export const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

export const SAFE_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
]);

export function inferImageExtension(input: { mimeType: string; fileName?: string }): string {
  const key = input.mimeType.toLowerCase();
  const fromMime = Object.hasOwn(IMAGE_EXTENSION_BY_MIME_TYPE, key)
    ? IMAGE_EXTENSION_BY_MIME_TYPE[key]
    : undefined;
  if (fromMime) {
    return fromMime;
  }

  const fromMimeExtension = Mime.getExtension(input.mimeType);
  if (fromMimeExtension && SAFE_IMAGE_FILE_EXTENSIONS.has(fromMimeExtension)) {
    return fromMimeExtension;
  }

  const fileName = input.fileName?.trim() ?? "";
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  if (SAFE_IMAGE_FILE_EXTENSIONS.has(fileNameExtension)) {
    return fileNameExtension;
  }

  return ".bin";
}

export function inferAttachmentExtension(input: { mimeType: string; fileName?: string }): string {
  const fileName = input.fileName?.trim() ?? "";
  if (fileName.length > 0 && !/[\\/]/.test(fileName)) {
    const extensionMatch = /^.+\.([a-z0-9]{1,8})$/i.exec(fileName);
    const extension = extensionMatch?.[1]?.toLowerCase();
    if (extension && /^[a-z0-9]{1,8}$/.test(extension)) {
      return `.${extension}`;
    }
  }

  const fromMimeExtension = Mime.getExtension(input.mimeType);
  if (fromMimeExtension && /^[a-z0-9]{1,8}$/i.test(fromMimeExtension)) {
    return `.${fromMimeExtension.toLowerCase()}`;
  }

  return ".bin";
}
