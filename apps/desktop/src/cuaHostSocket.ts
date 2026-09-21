import { lstat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";

/** Replace only an owned socket whose former listener is proven absent. */
export async function clearStaleCuaHostSocket(
  endpoint: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return;
  const candidate = await socketIdentity(endpoint);
  if (!candidate) return;

  const probe = await new Promise<"refused" | "missing">((resolve, reject) => {
    const socket = createConnection(endpoint);
    const finish = (result: "refused" | "missing" | Error) => {
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    socket.once("connect", () => finish(new Error(`A live host already listens on ${endpoint}.`)));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish("refused");
      else if (error.code === "ENOENT") finish("missing");
      else finish(error);
    });
    socket.setTimeout(1_000, () =>
      finish(new Error(`Could not determine whether a live host listens on ${endpoint}.`)),
    );
  });

  // A different host may have replaced the path while the probe was in
  // flight. Never unlink that host's listener based on the earlier result.
  const current = await socketIdentity(endpoint);
  if (!current) return;
  if (probe === "missing" || candidate.dev !== current.dev || candidate.ino !== current.ino)
    throw new Error(`The host socket changed while checking ${endpoint}; retry setup.`);
  await unlink(endpoint);
}

async function socketIdentity(endpoint: string) {
  const identity = await lstat(endpoint).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!identity) return undefined;
  if (!identity.isSocket())
    throw new Error(`Refusing to replace a non-socket host path: ${endpoint}.`);
  if (process.getuid && identity.uid !== process.getuid())
    throw new Error(`Refusing to replace a host socket owned by another user: ${endpoint}.`);
  return identity;
}
