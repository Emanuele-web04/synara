import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

// Stream large signed payloads instead of retaining an entire DMG/framework.
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
