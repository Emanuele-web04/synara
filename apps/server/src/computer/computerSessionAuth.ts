import { randomBytes } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const COMPUTER_SERVER_OWNER = "org.synara.ComputerUse.Server";

/** Created only while holding the exclusive D-Bus server name for this bus. */
export async function createComputerSessionAuth(busId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(busId)) throw new Error("Invalid D-Bus session identifier.");
  const path = join("/tmp", `synara-computer-use-${process.getuid!()}-${busId}.token`);
  const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (previous) {
    if (!previous.isFile() || previous.uid !== process.getuid!())
      throw new Error("Unsafe computer authentication file.");
    await unlink(path);
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(path, token, { mode: 0o600, flag: "wx" });
  return {
    token,
    async close() {
      if ((await readFile(path, "utf8").catch(() => undefined)) === token)
        await unlink(path).catch(() => undefined);
    },
  };
}
