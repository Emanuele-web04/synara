import { describe, expect, it } from "vitest";

import { assignBootBands, bootChunkGroups } from "./boot-chunk-groups";

// id -> [static imports, source length]
type Graph = Record<string, readonly [ReadonlyArray<string>, number]>;

function moduleGraph(graph: Graph) {
  return {
    getModuleInfo: (id: string) => {
      const module = graph[id];
      return module
        ? ({ importedIds: [...module[0]], code: "x".repeat(module[1]) } as never)
        : null;
    },
  };
}

const GRAPH: Graph = {
  "/app/entry.ts": [["/app/shared.ts"], 10],
  "/app/shared.ts": [[], 10],
  "/app/main.ts": [["/app/a.ts", "/app/shared.ts"], 10],
  "/app/a.ts": [["/app/b.ts"], 100],
  "/app/b.ts": [["/app/a.ts", "/app/c.ts"], 100],
  "/app/c.ts": [[], 100],
  "/app/chat.ts": [["/app/a.ts", "/app/d.ts"], 10],
  "/app/d.ts": [[], 100],
};

const options = (bandBytes: number) => ({
  root: "/app",
  entry: "entry.ts",
  steps: [
    { name: "main", root: "main.ts" },
    { name: "chat", root: "chat.ts" },
  ],
  bandBytes,
});

const bandIndex = (band: string | undefined) => Number(band?.split("-").at(-1));

describe("assignBootBands", () => {
  it("leaves the entry's closure out and puts a module in the first step that loads it", () => {
    const bands = assignBootBands(moduleGraph(GRAPH), options(1_000));

    expect(bands.has("/app/entry.ts")).toBe(false);
    expect(bands.has("/app/shared.ts")).toBe(false);
    expect(bands.get("/app/a.ts")).toBe("main-0");
    expect(bands.get("/app/d.ts")).toBe("chat-0");
  });

  it("keeps an import cycle in one band and never imports a later band", () => {
    const bands = assignBootBands(moduleGraph(GRAPH), options(150));

    expect(bands.get("/app/a.ts")).toBe(bands.get("/app/b.ts"));
    expect(new Set([...bands.values()].filter((band) => band.startsWith("main-"))).size).toBe(3);
    for (const [id, band] of bands) {
      for (const dep of GRAPH[id]![0]) {
        const depBand = bands.get(dep);
        if (depBand?.startsWith(band.replace(/-\d+$/, "-"))) {
          expect(bandIndex(depBand)).toBeLessThanOrEqual(bandIndex(band));
        }
      }
    }
  });

  it("fails the build when a step root is not in the module graph", () => {
    expect(() =>
      assignBootBands(moduleGraph(GRAPH), {
        ...options(1_000),
        steps: [{ name: "gone", root: "gone.ts" }],
      }),
    ).toThrow(/gone\.ts is not in the module graph/);
  });
});

describe("bootChunkGroups", () => {
  it("gives earlier bands higher priority and folds overflow into a step's last band", () => {
    const groups = bootChunkGroups({ ...options(150), priority: 100, maxBandsPerStep: 2 });
    const ctx = moduleGraph(GRAPH);
    const nameOf = (id: string) =>
      groups
        .map((group) => (typeof group.name === "function" ? group.name(id, ctx) : group.name))
        .filter(Boolean);

    expect(groups.map((group) => group.priority)).toEqual([100, 99, 98, 97]);
    expect(nameOf("/app/c.ts")).toEqual(["main-0"]);
    expect(nameOf("/app/a.ts")).toEqual(["main-1"]);
    // main.ts is band 2 of main; with two bands per step it joins main-1.
    expect(nameOf("/app/main.ts")).toEqual(["main-1"]);
    expect(nameOf("/app/entry.ts")).toEqual([]);
  });
});
