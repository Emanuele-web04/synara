import fs from "node:fs/promises";
import { withCredentialFileLock } from "../accountCredentialLock.ts";
const [credentials, mode] = process.argv.slice(2);
await withCredentialFileLock(credentials, async () => {
  if (mode === "crash") {
    process.stdout.write("locked\n");
    process.exit(0);
  }
  const marker = `${credentials}.critical-section`;
  const handle = await fs.open(marker, "wx");
  try {
    await new Promise((resolve) => setTimeout(resolve, 75));
    const count = Number(await fs.readFile(credentials, "utf8").catch(() => "0"));
    await fs.writeFile(credentials, String(count + 1));
  } finally {
    await handle.close();
    await fs.unlink(marker);
  }
});
