import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startCloudflareConnector } from "../cloudflare/connector";

const [executable, home] = process.argv.slice(2) as [string, string];
const lifetime = new AbortController();
const connector = startCloudflareConnector({
  executable: async () => executable,
  home,
  configurationFile: join(home, "managed.yml"),
  token: async () => "fixture-only-token",
  signal: lifetime.signal,
  ready: (ready) => {
    if (ready) void writeFile(join(home, "ready"), "ready");
  },
});
process.on("message", (message) => {
  if (message === "crash") {
    setImmediate(() => {
      throw new Error("Intentional backend crash fixture");
    });
  } else if (message === "stop") {
    void connector.stop().then(() => process.disconnect());
  }
});
