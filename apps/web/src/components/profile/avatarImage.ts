// FILE: avatarImage.ts
// Purpose: Compress a user-picked profile photo entirely on-device into a tiny, square
// data URL so it can be persisted in localStorage without consuming much space. No I/O
// leaves the device.
// Layer: web profile feature.

// Square output edge in CSS px. 160 covers the largest avatar (size-20 / share card) at 2x
// without storing anything close to the original photo.
const AVATAR_MAX_EDGE = 160;
const AVATAR_QUALITY = 0.82;

// Hard cap on the encoded string so a pathological image can never blow the localStorage
// budget. Comfortable for a 160px square (~5–12 KB typical).
export const AVATAR_MAX_DATA_URL_LENGTH = 200_000;

// Error keys for i18n translation
export const AVATAR_ERROR_KEYS = {
  COULD_NOT_READ_FILE: "profile.edit.couldNotReadFile",
  NOT_READABLE_IMAGE: "profile.edit.notReadableImage",
  PLEASE_CHOOSE_IMAGE: "profile.edit.pleaseChooseImage",
  IMAGE_HAS_NO_PIXELS: "profile.edit.imageHasNoPixels",
  COMPRESSION_NOT_SUPPORTED: "profile.edit.compressionNotSupported",
  IMAGE_TOO_LARGE: "profile.edit.imageTooLarge",
} as const;

export class AvatarImageError extends Error {
  constructor(public readonly i18nKey: string) {
    super(i18nKey);
    this.name = "AvatarImageError";
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new AvatarImageError(AVATAR_ERROR_KEYS.COULD_NOT_READ_FILE));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new AvatarImageError(AVATAR_ERROR_KEYS.NOT_READABLE_IMAGE));
    img.src = src;
  });
}

// Resize + center-crop to a square and re-encode (WebP, JPEG fallback) at low quality.
export async function compressAvatarImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new AvatarImageError(AVATAR_ERROR_KEYS.PLEASE_CHOOSE_IMAGE);
  }

  const sourceUrl = await readFileAsDataUrl(file);
  const img = await loadImage(sourceUrl);

  const sourceEdge = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  if (sourceEdge <= 0) {
    throw new AvatarImageError(AVATAR_ERROR_KEYS.IMAGE_HAS_NO_PIXELS);
  }
  const edge = Math.min(AVATAR_MAX_EDGE, sourceEdge);

  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new AvatarImageError(AVATAR_ERROR_KEYS.COMPRESSION_NOT_SUPPORTED);
  }

  const sx = ((img.naturalWidth || img.width) - sourceEdge) / 2;
  const sy = ((img.naturalHeight || img.height) - sourceEdge) / 2;
  ctx.drawImage(img, sx, sy, sourceEdge, sourceEdge, 0, 0, edge, edge);

  const webp = canvas.toDataURL("image/webp", AVATAR_QUALITY);
  const dataUrl = webp.startsWith("data:image/webp")
    ? webp
    : canvas.toDataURL("image/jpeg", AVATAR_QUALITY);

  if (dataUrl.length > AVATAR_MAX_DATA_URL_LENGTH) {
    throw new AvatarImageError(AVATAR_ERROR_KEYS.IMAGE_TOO_LARGE);
  }
  return dataUrl;
}
