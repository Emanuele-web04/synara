import { describe, expect, it } from "vitest";
import { countSyncFsReferences, syncFsViolations } from "./check-server-sync-fs.ts";

describe("server synchronous filesystem guard", () => {
  it("recognizes named aliases, namespace, computed, native and destructured access", () => {
    expect(
      countSyncFsReferences(`
      import fs from "node:fs";
      import * as disk from "fs";
      import { readFileSync as read } from "node:fs";
      read("a"); disk.statSync("a"); fs["lstatSync"]("a");
      fs.realpathSync.native("a"); const { existsSync: exists } = fs;
    `),
    ).toEqual({ readFileSync: 1, statSync: 1, lstatSync: 1, realpathSync: 1, existsSync: 1 });
  });
  it("ignores comments, strings, type imports and asynchronous operations", () => {
    expect(
      countSyncFsReferences(`
      import type { Stats } from "node:fs";
      import fs from "node:fs/promises";
      // readFileSync("a")
      const label = "fs.statSync()";
      await fs.readFile("a");
    `),
    ).toEqual({});
  });
  it("rejects a new operation or added reference even in an exempted file", () => {
    const budget = {
      "startup.ts": { reason: "Startup-only migration identity", references: { statSync: 1 } },
    };
    const prefix = 'import fs from "node:fs";';
    expect(syncFsViolations("startup.ts", prefix + 'fs.statSync("a")', budget)).toEqual([]);
    expect(
      syncFsViolations("startup.ts", prefix + 'fs.statSync("a"); fs.statSync("b")', budget),
    ).toHaveLength(1);
    expect(syncFsViolations("startup.ts", prefix + 'fs.readFileSync("a")', budget)).toHaveLength(1);
    expect(syncFsViolations("new.ts", prefix + 'fs.statSync("a")', budget)).toHaveLength(1);
    expect(syncFsViolations("new.ts", prefix + 'fs[name]("a")', budget)).toHaveLength(1);
    expect(
      syncFsViolations("new.ts", 'const fs = require("node:fs"); fs.statSync("a")', budget),
    ).toHaveLength(1);
    expect(syncFsViolations("new.ts", 'const fs = await import("node:fs")', budget)).toHaveLength(
      1,
    );
    expect(
      syncFsViolations("new.ts", 'export { readFileSync } from "node:fs"', budget),
    ).toHaveLength(1);
  });
});
