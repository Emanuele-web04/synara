import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveCodexGeneratedImagesRoot } from "../codexGeneratedImages.ts";

/**
 * Proof screenshots use the existing durable image store and chat image
 * allowlist, so an embedded proof renders in the chat. Browser and simulator
 * proofs share it; `category` only keeps their folders apart.
 */
export async function saveBrowserProof(
  threadId: string,
  data: string,
  root = resolveCodexGeneratedImagesRoot(),
  category: "browser-proof" | "device-proof" = "browser-proof",
): Promise<string> {
  const png = Buffer.from(data, "base64");
  if (
    png.length < 24 ||
    png.length > 8 * 1024 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("Invalid proof image");
  }
  const owner = createHash("sha256").update(threadId).digest("hex").slice(0, 24);
  const directory = path.join(root, category, owner);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${randomUUID()}.png`);
  await writeFile(file, png, { flag: "wx", mode: 0o600 });
  return file;
}
