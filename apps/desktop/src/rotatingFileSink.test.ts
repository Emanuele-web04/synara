import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RotatingFileSink } from "@synara/shared/logging";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-rotating-log-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RotatingFileSink", () => {
  it("rotates when writes exceed max bytes", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "desktop-main.log");
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 10,
      maxFiles: 3,
    });

    sink.write("12345");
    sink.write("67890");
    sink.write("abc");

    expect(fs.readFileSync(path.join(dir, "desktop-main.log"), "utf8")).toBe("abc");
    expect(fs.readFileSync(path.join(dir, "desktop-main.log.1"), "utf8")).toBe("1234567890");
  });

  it("retains only maxFiles backups", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "server-child.log");
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 4,
      maxFiles: 2,
    });

    sink.write("aaaa");
    sink.write("bbbb");
    sink.write("cccc");
    sink.write("dddd");

    expect(fs.existsSync(path.join(dir, "server-child.log.1"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "server-child.log.2"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "server-child.log.3"))).toBe(false);
  });

  it("keeps one descriptor open and reopens it across rotations", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "server-child.log");
    const openSpy = vi.spyOn(fs, "openSync");
    const appendSpy = vi.spyOn(fs, "appendFileSync");
    try {
      const sink = new RotatingFileSink({
        filePath: logPath,
        maxBytes: 10,
        maxFiles: 2,
        keepFileOpen: true,
      });

      sink.write("12345");
      sink.write("67890");
      expect(openSpy).toHaveBeenCalledTimes(1);

      sink.write("abc");
      sink.write("def");
      sink.write("ghijk");
      sink.write("lmnop");
      sink.close();
      sink.close();

      expect(appendSpy).not.toHaveBeenCalled();
      // One open per active file: the initial one plus one after each rotation.
      expect(openSpy).toHaveBeenCalledTimes(3);
      expect(fs.readFileSync(logPath, "utf8")).toBe("ghijklmnop");
      expect(fs.readFileSync(path.join(dir, "server-child.log.1"), "utf8")).toBe("abcdef");
      expect(fs.readFileSync(path.join(dir, "server-child.log.2"), "utf8")).toBe("1234567890");

      // A write after close() reopens the file; this one also rotates.
      sink.write("x");
      sink.close();
      expect(fs.readFileSync(logPath, "utf8")).toBe("x");
      expect(fs.readFileSync(path.join(dir, "server-child.log.1"), "utf8")).toBe("ghijklmnop");
    } finally {
      openSpy.mockRestore();
      appendSpy.mockRestore();
    }
  });

  it("prunes stale backups above maxFiles on startup", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "desktop-main.log");
    fs.writeFileSync(path.join(dir, "desktop-main.log.1"), "first");
    fs.writeFileSync(path.join(dir, "desktop-main.log.4"), "stale");

    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 16,
      maxFiles: 2,
    });
    sink.write("hello");

    expect(fs.existsSync(path.join(dir, "desktop-main.log.4"))).toBe(false);
  });
});
