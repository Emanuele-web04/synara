const HEX_DIGITS = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += HEX_DIGITS[(byte >> 4) & 0xf] ?? "0";
    hex += HEX_DIGITS[byte & 0xf] ?? "0";
  }
  return hex;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}
