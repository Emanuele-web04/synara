import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHROMIUM_DATABASE_BYTES } from "./chromiumProfileInventory";
import { readChromiumProfilePasswords } from "./chromiumPasswordReader";

const sqlite = vi.hoisted(() => ({ exec: vi.fn(), prepare: vi.fn(), close: vi.fn() }));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    exec = sqlite.exec;
    prepare = sqlite.prepare;
    close = sqlite.close;
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let home: string;

beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  home = await mkdtemp(join(tmpdir(), "synara-password-logical-size-"));
  sqlite.exec.mockReset();
  sqlite.close.mockReset();
  sqlite.prepare.mockImplementation((query: string) => ({
    get: () => {
      if (query === "PRAGMA page_count")
        return { page_count: Math.floor(MAX_CHROMIUM_DATABASE_BYTES / 4096) + 1 };
      if (query === "PRAGMA page_size") return { page_size: 4096 };
      return { type: "table" };
    },
  }));
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  await rm(home, { recursive: true, force: true });
});

describe("Chromium password logical database size guard", () => {
  it("preserves source_too_large when the selected SQLite snapshot crosses the cap", async () => {
    const profile = join(home, "Library", "Application Support", "Google", "Chrome", "Default");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "Login Data"), "sqlite fixture");

    await expect(
      readChromiumProfilePasswords(home, "chrome", "Default", "test-safe-storage"),
    ).rejects.toMatchObject({ code: "source_too_large" });
  });
});
