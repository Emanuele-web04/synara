import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createComputerSessionAuth } from "./computerSessionAuth.ts";

const BUS_ID = "3f0a9c2e1b4d4e5f8a6b7c8d9e0f1a2b";

describe("createComputerSessionAuth", () => {
  let directory: string;
  const tokenPath = (busId: string) =>
    join(directory, `synara-computer-use-${process.getuid!()}-${busId}.token`);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "synara-computer-auth-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ["a space", "abc def"],
    ["a slash", "abc/def"],
    ["a parent segment", "../etc"],
    ["a dot", "abc.def"],
    ["an empty id", ""],
    ["more than 128 characters", "a".repeat(129)],
  ])("refuses a bus id with %s", async (_label, busId) => {
    await expect(createComputerSessionAuth(busId, directory)).rejects.toThrow();
  });

  it("accepts a machine bus id and writes a private token file", async () => {
    const auth = await createComputerSessionAuth(BUS_ID, directory);
    try {
      expect(auth.token).toMatch(/^[0-9a-f]{64}$/);
      const info = await stat(tokenPath(BUS_ID));
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o777).toBe(0o600);
      await expect(readFile(tokenPath(BUS_ID), "utf8")).resolves.toBe(auth.token);
    } finally {
      await auth.close();
    }
  });

  it("accepts an id at the 128 character limit", async () => {
    const busId = "b".repeat(128);
    const auth = await createComputerSessionAuth(busId, directory);
    await auth.close();
    await expect(stat(tokenPath(busId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlink at the token path", async () => {
    const target = join(directory, "elsewhere");
    await writeFile(target, "victim");
    await symlink(target, tokenPath(BUS_ID));
    await expect(createComputerSessionAuth(BUS_ID, directory)).rejects.toThrow();
    // Neither the link nor its target was touched: nothing followed or
    // replaced the link.
    expect((await lstat(tokenPath(BUS_ID))).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("victim");
  });

  it("replaces a stale regular file owned by this user", async () => {
    await writeFile(tokenPath(BUS_ID), "stale token", { mode: 0o644 });
    const auth = await createComputerSessionAuth(BUS_ID, directory);
    try {
      await expect(readFile(tokenPath(BUS_ID), "utf8")).resolves.toBe(auth.token);
      const info = await stat(tokenPath(BUS_ID));
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await auth.close();
    }
  });

  it("removes the file on close only while it still holds this token", async () => {
    const first = await createComputerSessionAuth(BUS_ID, directory);
    await first.close();
    await expect(stat(tokenPath(BUS_ID))).rejects.toMatchObject({ code: "ENOENT" });

    const second = await createComputerSessionAuth(BUS_ID, directory);
    // A newer server replaced the file (or an unrelated file appeared). Closing
    // the old auth must not take the newer server's token with it.
    await writeFile(tokenPath(BUS_ID), "successor token");
    await second.close();
    await expect(readFile(tokenPath(BUS_ID), "utf8")).resolves.toBe("successor token");

    // Closing after the file is gone is a no-op, not a failure.
    await rm(tokenPath(BUS_ID));
    await expect(second.close()).resolves.toBeUndefined();
  });

  it("never reuses a token between sessions", async () => {
    const first = await createComputerSessionAuth(BUS_ID, directory);
    await first.close();
    const second = await createComputerSessionAuth(BUS_ID, directory);
    await second.close();
    expect(second.token).not.toBe(first.token);
  });
});
