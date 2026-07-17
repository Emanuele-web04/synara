export function requireHttpExternalUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Only HTTP(S) links can be opened externally.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) links can be opened externally.");
  }
  return trimmed;
}
