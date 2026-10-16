import { inventoryChromiumPasswordProfile } from "./chromiumProfileInventory";
import { readChromiumProfilePasswords } from "./chromiumPasswordReader";
import type { ChromiumInventorySourceId } from "./chromiumProfileInventory";

const MAX_INPUT_BYTES = 64 * 1024;

type Request = {
  action: "preflight" | "read";
  home: string;
  browser: ChromiumInventorySourceId;
  profile: string;
  passphrase?: string;
};

async function main() {
  const chunks: Buffer[] = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputBytes += bytes.byteLength;
    if (inputBytes > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ ok: false, code: "source_too_large" }));
      process.exitCode = 2;
      return;
    }
    chunks.push(bytes);
  }

  let request: Request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, code: "reader_failed" }));
    process.exitCode = 2;
    return;
  }

  try {
    if (request.action === "preflight") {
      const profile = await inventoryChromiumPasswordProfile(
        request.home,
        request.browser,
        request.profile,
      );
      process.stdout.write(JSON.stringify({ ok: true, profile: profile ?? null }));
      return;
    }
    if (request.action === "read" && typeof request.passphrase === "string") {
      const result = await readChromiumProfilePasswords(
        request.home,
        request.browser,
        request.profile,
        request.passphrase,
      );
      process.stdout.write(JSON.stringify({ ok: true, result }));
      return;
    }
    process.stdout.write(JSON.stringify({ ok: false, code: "reader_failed" }));
    process.exitCode = 2;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : "reader_failed";
    process.stdout.write(
      JSON.stringify({ ok: false, code: typeof code === "string" ? code : "reader_failed" }),
    );
  } finally {
    request.passphrase = "";
  }
}

void main();
