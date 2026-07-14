import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { writeFileStringAtomically } from "./atomicWrite";
import { PRIVATE_FILE_MODE } from "./privatePathPermissions";

describe.skipIf(process.platform === "win32")("private atomic writes", () => {
  it("creates and replaces files with owner-only permissions", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-private-"));
    const filePath = path.join(directory, "state.json");
    fs.writeFileSync(filePath, "old", { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);

    try {
      await Effect.runPromise(
        writeFileStringAtomically({ filePath, contents: "new" }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );

      expect(fs.readFileSync(filePath, "utf8")).toBe("new");
      expect(fs.statSync(filePath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows concurrent writers without sharing temporary files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-concurrent-"));
    const filePath = path.join(directory, "state.json");
    const contents = Array.from({ length: 32 }, (_, index) => `value-${index}`);
    const reusableWrite = writeFileStringAtomically({ filePath, contents: contents[0]! });

    try {
      await Effect.runPromise(
        Effect.all(
          [
            ...contents.map((value) => writeFileStringAtomically({ filePath, contents: value })),
            ...Array.from({ length: 8 }, () => reusableWrite),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.provide(NodeServices.layer)),
      );

      expect(contents).toContain(fs.readFileSync(filePath, "utf8"));
      expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces a final symlink without changing its outside target", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-symlink-"));
    const outsidePath = path.join(directory, "outside.json");
    const filePath = path.join(directory, "state.json");
    const hostileTempPath = `${filePath}.${process.pid}.hostile.tmp`;
    fs.writeFileSync(outsidePath, "outside", { mode: 0o644 });
    fs.symlinkSync(outsidePath, filePath);
    fs.symlinkSync(outsidePath, hostileTempPath);

    try {
      await Effect.runPromise(
        writeFileStringAtomically({ filePath, contents: "inside" }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );

      expect(fs.readFileSync(outsidePath, "utf8")).toBe("outside");
      expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(filePath, "utf8")).toBe("inside");
      expect(fs.lstatSync(hostileTempPath).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked parent directory without changing its outside target", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-parent-"));
    const outsideDirectory = path.join(directory, "outside");
    const linkedDirectory = path.join(directory, "linked");
    const outsidePath = path.join(outsideDirectory, "state.json");
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(outsidePath, "outside");
    fs.symlinkSync(outsideDirectory, linkedDirectory);

    try {
      await expect(
        Effect.runPromise(
          writeFileStringAtomically({
            filePath: path.join(linkedDirectory, "state.json"),
            contents: "inside",
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      ).rejects.toThrow(linkedDirectory);
      expect(fs.readFileSync(outsidePath, "utf8")).toBe("outside");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a parent directory writable by other users", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-parent-mode-"));
    const filePath = path.join(directory, "state.json");
    fs.chmodSync(directory, 0o777);

    try {
      await expect(
        Effect.runPromise(
          writeFileStringAtomically({ filePath, contents: "private" }).pipe(
            Effect.provide(NodeServices.layer),
          ),
        ),
      ).rejects.toThrow("group/other writable");
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the requested mode even under a restrictive umask", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-umask-"));
    const filePath = path.join(directory, "state.json");
    const previousUmask = process.umask(0o777);

    try {
      await Effect.runPromise(
        writeFileStringAtomically({ filePath, contents: "private", mode: 0o640 }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
    } finally {
      process.umask(previousUmask);
    }

    try {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o640);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("repairs a newly created parent chain under a restrictive umask", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-parent-umask-"));
    const parentPath = path.join(directory, "new", "nested");
    const filePath = path.join(parentPath, "state.json");
    const previousUmask = process.umask(0o777);

    try {
      await Effect.runPromise(
        writeFileStringAtomically({ filePath, contents: "private" }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
    } finally {
      process.umask(previousUmask);
    }

    try {
      expect(fs.statSync(path.join(directory, "new")).mode & 0o777).toBe(0o700);
      expect(fs.statSync(parentPath).mode & 0o777).toBe(0o700);
      expect(fs.statSync(filePath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
      expect(fs.readFileSync(filePath, "utf8")).toBe("private");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finishes an in-flight commit before interruption is observed", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-interrupt-"));
    const filePath = path.join(directory, "state.bin");
    const contents = "x".repeat(32 * 1024 * 1024);

    try {
      const sawTemporaryFile = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            writeFileStringAtomically({ filePath, contents }).pipe(
              Effect.provide(NodeServices.layer),
            ),
          );
          const sawTemp = yield* Effect.promise(async () => {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              const entries = fs.readdirSync(directory);
              if (entries.some((entry) => entry.endsWith(".tmp"))) return true;
              if (fs.existsSync(filePath)) return false;
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return false;
          });
          yield* Fiber.interrupt(fiber);
          return sawTemp;
        }),
      );

      expect(sawTemporaryFile).toBe(true);
      expect(fs.statSync(filePath).size).toBe(Buffer.byteLength(contents));
      expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes its temporary file when replacement fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synara-atomic-cleanup-"));
    const filePath = path.join(directory, "state.json");
    fs.mkdirSync(filePath);

    try {
      await expect(
        Effect.runPromise(
          writeFileStringAtomically({ filePath, contents: "new" }).pipe(
            Effect.provide(NodeServices.layer),
          ),
        ),
      ).rejects.toBeDefined();
      expect(fs.statSync(filePath).isDirectory()).toBe(true);
      expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
