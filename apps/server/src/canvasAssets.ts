import { realpath } from "node:fs/promises";
import path from "node:path";
import type { CanvasAssetUpload, CanvasImportImageInput } from "@synara/contracts";
import { pngDimensions } from "./pngHeader";
import { jpegDimensions } from "./jpegHeader";
import { readAuthorizedFileBytes } from "./workspace/readAuthorizedFileBytes";

/** Work-owned assets have no chat retention lease, external URL, or startup credential. */
export async function importCanvasAsset(
  workspaceRoot: string,
  sourcePath: string,
  id: string,
): Promise<CanvasAssetUpload> {
  const root = await realpath(workspaceRoot);
  const bytes = await readAuthorizedFileBytes(sourcePath, workspaceRoot, [root], 2_097_152);
  if (!bytes)
    throw new Error(
      "Asset must be an unchanged regular file within this chat's workspace, at most 2 MiB.",
    );
  const png = pngDimensions(bytes);
  const jpeg = png ? null : jpegDimensions(bytes);
  const dimensions = png ?? jpeg;
  const mimeType = png ? "image/png" : jpeg ? "image/jpeg" : "font/woff2";
  if (dimensions) {
    if (dimensions.width * dimensions.height > 40_000_000)
      throw new Error("Canvas images must not exceed 40 megapixels.");
  } else if (
    bytes.length < 48 ||
    bytes.toString("ascii", 0, 4) !== "wOF2" ||
    bytes.readUInt32BE(8) !== bytes.length ||
    bytes.readUInt32BE(16) > 20_971_520
  ) {
    throw new Error(
      "Import a PNG, JPEG, or WOFF2 file. Convert other formats in the workspace first.",
    );
  }
  return {
    id,
    name: path.basename(sourcePath).slice(0, 120) || id,
    mimeType,
    sizeBytes: bytes.length,
    data: bytes.toString("base64"),
    ...dimensions,
  };
}

const MAX_IMAGE_PIXELS = 40_000_000;

function gifDimensions(bytes: Buffer) {
  if (bytes.length < 10 || !/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function webpDimensions(bytes: Buffer) {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  )
    return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X")
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  return null;
}

/** Pasted and dropped images: the declared type must match the bytes. */
export function canvasImageAsset(input: CanvasImportImageInput): CanvasAssetUpload {
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length === 0 || bytes.length > 2_097_152)
    throw new Error("Canvas images must be at most 2 MiB. Resize it and try again.");
  const dimensions =
    input.mimeType === "image/png"
      ? pngDimensions(bytes)
      : input.mimeType === "image/jpeg"
        ? jpegDimensions(bytes)
        : input.mimeType === "image/gif"
          ? gifDimensions(bytes)
          : webpDimensions(bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1)
    throw new Error("The file is not a valid PNG, JPEG, WebP or GIF image.");
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS)
    throw new Error("Canvas images must not exceed 40 megapixels.");
  return {
    id: input.assetId,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: bytes.length,
    data: input.data,
    width: dimensions.width,
    height: dimensions.height,
  };
}
