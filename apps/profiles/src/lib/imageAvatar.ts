// The avatar as next/og can draw it. Its renderer decodes PNG and JPEG only, while
// uploaded avatars are WebP; handing it one draws nothing at all. So the image routes
// embed a PNG/JPEG avatar as a data URL and fall back to the initials otherwise.

const DRAWABLE_TYPES = new Set(["image/png", "image/jpeg"]);
/** Well above a real avatar (the API caps uploads at 300KB); bounds a hostile response. */
const MAX_AVATAR_BYTES = 2_000_000;

export function isDrawableAvatarType(contentType: string | null): boolean {
  return DRAWABLE_TYPES.has((contentType ?? "").split(";")[0]!.trim().toLowerCase());
}

/** A data URL next/og can draw, or null to draw the initials instead. */
export async function drawableAvatar(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await fetch(url);
    const type = response.headers.get("content-type");
    if (!response.ok || !isDrawableAvatarType(type)) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_AVATAR_BYTES) return null;
    return `data:${type!.split(";")[0]!.trim()};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}
