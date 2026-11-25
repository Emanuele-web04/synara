import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { withCredentialFileLock } from "./accountCredentialLock";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-credential-lock-"));
  roots.push(root);
  return path.join(root, "credentials.json");
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
function worker(credentials: string, mode = "increment") {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        fileURLToPath(new URL("./__fixtures__/credentialLockWorker.mjs", import.meta.url)),
        credentials,
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (data) => {
      errors += data;
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(errors))));
  });
}
it("serializes real processes contending for a dead owner's lock", async () => {
  const credentials = await fixture();
  await worker(credentials, "crash");
  await Promise.all([worker(credentials), worker(credentials), worker(credentials)]);
  expect(await fs.readFile(credentials, "utf8")).toBe("3");
  expect(await fs.readdir(path.dirname(credentials))).toEqual(["credentials.json"]);
});
it("serializes same-process writers and releases after a rejected operation", async () => {
  const credentials = await fixture();
  const calls: number[] = [];
  await expect(
    withCredentialFileLock(credentials, async () => {
      throw new Error("failed refresh");
    }),
  ).rejects.toThrow("failed refresh");
  await Promise.all(
    [1, 2, 3].map((n) =>
      withCredentialFileLock(credentials, async () => {
        calls.push(n);
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push(n);
      }),
    ),
  );
  expect(calls).toEqual([1, 1, 2, 2, 3, 3]);
});
it("never removes a legacy lock whose ownership cannot be proven", async () => {
  const credentials = await fixture();
  await fs.writeFile(`${credentials}.lock`, "old-owner");
  await expect(withCredentialFileLock(credentials, async () => {})).rejects.toThrow(
    "Legacy credential lock",
  );
  expect(await fs.readFile(`${credentials}.lock`, "utf8")).toBe("old-owner");
});
