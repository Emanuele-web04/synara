import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { withTransformCache } from "./transform-cache";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

type Handler = (
  this: unknown,
  code: string,
  id: string,
  options?: { moduleType?: string },
) => Promise<unknown>;

async function fixture(salt = "salt-a", directory?: string, coordinateWrites = false) {
  const root = directory ?? (await fs.mkdtemp(path.join(tmpdir(), "synara-transform-cache-")));
  if (!directory) roots.push(root);
  const calls: string[] = [];
  const plugin = withTransformCache(
    {
      name: "fixture",
      transform: {
        filter: undefined as unknown,
        async handler(code: string, id: string): Promise<unknown> {
          calls.push(id);
          if (code.includes("untouched")) return undefined;
          return { code: `compiled(${code})`, map: { mappings: code.length } };
        },
      },
    },
    { directory: root, salt, coordinateWrites },
  );
  const handler = plugin.transform.handler as Handler;
  const run = (code: string, id = "/src/a.tsx", environment = "client", moduleType = "tsx") =>
    handler.call({ environment: { name: environment } }, code, id, { moduleType });
  return { root, calls, run, plugin };
}

const entries = async (root: string) =>
  (await fs.readdir(root, { recursive: true })).filter((entry) => entry.endsWith(".json"));

describe("withTransformCache", () => {
  it("reuses an unchanged module and recompiles a changed one", async () => {
    const first = await fixture();
    const compiled = await first.run("const a = 1");
    expect(compiled).toEqual({ code: "compiled(const a = 1)", map: { mappings: 11 } });

    const second = await fixture("salt-a", first.root);
    expect(await second.run("const a = 1")).toEqual(compiled);
    expect(second.calls).toEqual([]);

    // A real edit must reach the compiler: the old entry can never answer for it.
    expect(await second.run("const a = 2")).toEqual({
      code: "compiled(const a = 2)",
      map: { mappings: 11 },
    });
    expect(second.calls).toEqual(["/src/a.tsx"]);
  });

  it("shares a cold transform between callers with the same cache", async () => {
    const first = await fixture("salt-a", undefined, true);
    const second = await fixture("salt-a", first.root, true);
    const compiled = { code: "compiled(const a = 1)", map: { mappings: 11 } };

    expect(await Promise.all([first.run("const a = 1"), second.run("const a = 1")])).toEqual([
      compiled,
      compiled,
    ]);
    expect([...first.calls, ...second.calls]).toEqual(["/src/a.tsx"]);
  });

  it("runs both transforms when neither caller can publish a cache entry", async () => {
    const first = await fixture("salt-a", undefined, true);
    const second = await fixture("salt-a", first.root, true);

    expect(await Promise.all([first.run("untouched"), second.run("untouched")])).toEqual([
      undefined,
      undefined,
    ]);
    expect(first.calls).toEqual(["/src/a.tsx"]);
    expect(second.calls).toEqual(["/src/a.tsx"]);
    expect(await entries(first.root)).toEqual([]);
  });

  // Find the entry path for a module, then leave a claim on it as another
  // process would, with no published entry.
  async function claimedModule(owner?: { pid: number; host: string }) {
    const seed = await fixture();
    await seed.run("const a = 1");
    const [entry] = await entries(seed.root);
    const entryPath = path.join(seed.root, entry!);
    await fs.rm(entryPath);
    const claimPath = `${entryPath}.lock`;
    await fs.mkdir(claimPath);
    if (owner) await fs.writeFile(path.join(claimPath, "owner"), JSON.stringify(owner));
    return { root: seed.root, entryPath, claimPath };
  }

  it("takes over a claim whose process has exited", async () => {
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    const { root, claimPath } = await claimedModule({ pid: exited, host: hostname() });
    const caller = await fixture("salt-a", root, true);

    expect(await caller.run("const a = 1")).toEqual({
      code: "compiled(const a = 1)",
      map: { mappings: 11 },
    });
    expect(caller.calls).toEqual(["/src/a.tsx"]);
    expect(await entries(root)).toHaveLength(1);
    await expect(fs.access(claimPath)).rejects.toThrow();
  });

  it("takes over a claim recorded on another host", async () => {
    const { root } = await claimedModule({ pid: process.pid, host: `${hostname()}-other` });
    const caller = await fixture("salt-a", root, true);

    await caller.run("const a = 1");
    expect(caller.calls).toEqual(["/src/a.tsx"]);
  });

  it("takes over a claim that never recorded an owner", async () => {
    const { root } = await claimedModule();
    const caller = await fixture("salt-a", root, true);

    await caller.run("const a = 1");
    expect(caller.calls).toEqual(["/src/a.tsx"]);
  }, 10_000);

  it("waits for a live owner and reuses its published entry", async () => {
    const { root, entryPath, claimPath } = await claimedModule({
      pid: process.pid,
      host: hostname(),
    });
    const caller = await fixture("salt-a", root, true);
    const published = { code: "compiled by owner", map: null };
    const waiting = caller.run("const a = 1");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(caller.calls).toEqual([]);
    await fs.writeFile(entryPath, JSON.stringify(published));
    await fs.rm(claimPath, { recursive: true });

    expect(await waiting).toEqual(published);
    expect(caller.calls).toEqual([]);
  });

  it("keys entries by salt, module id, environment and module type", async () => {
    const { root, run } = await fixture();
    await run("const a = 1");
    for (const [salt, id, environment, moduleType] of [
      ["salt-b", "/src/a.tsx", "client", "tsx"],
      ["salt-a", "/src/b.tsx", "client", "tsx"],
      ["salt-a", "/src/a.tsx", "ssr", "tsx"],
      ["salt-a", "/src/a.tsx", "client", "ts"],
    ] as const) {
      const other = await fixture(salt, root);
      await other.run("const a = 1", id, environment, moduleType);
      expect(other.calls, `${salt} ${id} ${environment} ${moduleType}`).toEqual([id]);
    }
    expect(await entries(root)).toHaveLength(5);
  });

  it("recompiles instead of trusting a malformed entry", async () => {
    const first = await fixture();
    await first.run("const a = 1");
    const [entry] = await entries(first.root);
    await fs.writeFile(path.join(first.root, entry!), '{"code":');

    const second = await fixture("salt-a", first.root);
    expect(await second.run("const a = 1")).toEqual({
      code: "compiled(const a = 1)",
      map: { mappings: 11 },
    });
    expect(second.calls).toEqual(["/src/a.tsx"]);
  });

  it("still compiles when the cache path is unavailable", async () => {
    const { root } = await fixture();
    const unavailable = path.join(root, "not-a-directory");
    await fs.writeFile(unavailable, "an existing file");
    const { run } = await fixture("salt-a", unavailable);

    expect(await run("const a = 1")).toEqual({
      code: "compiled(const a = 1)",
      map: { mappings: 11 },
    });
  });

  it("does not store a transform that left the module unchanged", async () => {
    const { root, run, calls } = await fixture();
    expect(await run("untouched")).toBeUndefined();
    expect(await run("untouched")).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(await entries(root)).toEqual([]);
  });

  it("keeps the hook object the plugin mutates after config resolution", async () => {
    const { plugin } = await fixture();
    const hook = plugin.transform;
    plugin.transform.filter = { id: /\.tsx$/ };
    expect(plugin.transform).toBe(hook);
    expect(hook.filter).toEqual({ id: /\.tsx$/ });
  });

  it("rejects a plugin without an object transform hook", () => {
    expect(() =>
      withTransformCache({ name: "bare" }, { directory: tmpdir(), salt: "salt" }),
    ).toThrow("no object transform hook");
  });
});
