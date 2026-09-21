// FILE: jpegHeader.ts
// Purpose: Read a JPEG's pixel dimensions out of its own headers.
// Layer: Server utility
// Exports: jpegDimensions
//
// Capture backends derive frame dimensions from encoded pixels rather than
// assuming the requested size matches the image returned by macOS — the same
// contract pngHeader.ts keeps for PNG captures.

export interface JpegDimensions {
  readonly width: number;
  readonly height: number;
}

/** `SOI` — the two bytes every conformant JPEG opens with. */
const JPEG_SOI = [0xff, 0xd8] as const;
/** Markers that carry no length field: SOI, EOI, RST0-7, TEM. */
const isStandaloneMarker = (marker: number) =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
/**
 * Start-of-frame markers carry the image's dimensions. Excluded: DHT (0xc4),
 * JPG (0xc8), DAC (0xcc) — same range, different payloads.
 */
const isStartOfFrame = (marker: number) =>
  (marker >= 0xc0 && marker <= 0xc3) ||
  (marker >= 0xc5 && marker <= 0xc7) ||
  (marker >= 0xc9 && marker <= 0xcb) ||
  (marker >= 0xcd && marker <= 0xcf);

/**
 * Width and height from the first start-of-frame segment, or `null` for
 * anything that is not a JPEG whose header declares a non-empty image.
 * Bounds-checked throughout: a truncated or non-JPEG byte string returns
 * `null`, never throws.
 */
export function jpegDimensions(bytes: Uint8Array): JpegDimensions | null {
  if (bytes.byteLength < 4) return null;
  if (bytes[0] !== JPEG_SOI[0] || bytes[1] !== JPEG_SOI[1]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    // Fill bytes before a marker are legal and always 0xff.
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1]!;
    while (marker === 0xff && offset + 2 < bytes.byteLength) {
      offset += 1;
      marker = bytes[offset + 1]!;
    }
    if (isStandaloneMarker(marker)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.byteLength) return null;
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      // Segment payload: precision byte, then height, then width.
      if (offset + 9 > bytes.byteLength) return null;
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    // SOS begins entropy-coded data: no more headers to walk.
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}
