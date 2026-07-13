// FILE: FactoryPluginDiscovery.test.ts
// Purpose: Verifies read-only mapping of Factory marketplace manifests into provider contracts.
// Layer: Provider filesystem discovery tests
// Depends on: FactoryPluginDiscovery and temporary filesystem fixtures.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listFactoryPlugins, readFactoryPlugin } from "./FactoryPluginDiscovery.ts";

const tempDirs: string[] = [];

async function makeFactoryFixture() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-factory-plugins-"));
  tempDirs.push(homeDir);
  const factoryDir = path.join(homeDir, ".factory");
  const marketplacePath = path.join(factoryDir, "plugins", "marketplaces", "official");
  const pluginPath = path.join(marketplacePath, "plugins", "reviewer");
  await fs.mkdir(path.join(marketplacePath, ".factory-plugin"), { recursive: true });
  await fs.mkdir(path.join(pluginPath, ".factory-plugin"), { recursive: true });
  await fs.mkdir(path.join(pluginPath, "skills", "review"), { recursive: true });
  await fs.mkdir(path.join(factoryDir, "cache"), { recursive: true });
  await fs.writeFile(
    path.join(factoryDir, "plugins", "known_marketplaces.json"),
    JSON.stringify({ official: { installLocation: marketplacePath } }),
  );
  await fs.writeFile(
    path.join(marketplacePath, ".factory-plugin", "marketplace.json"),
    JSON.stringify({
      name: "Official Factory",
      plugins: [
        {
          name: "reviewer",
          description: "Reviews changes",
          source: "./plugins/reviewer",
          category: "quality",
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(pluginPath, ".factory-plugin", "plugin.json"),
    JSON.stringify({
      name: "Reviewer",
      description: "Reviews changes safely",
      author: { name: "Factory" },
    }),
  );
  await fs.writeFile(
    path.join(pluginPath, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\n",
  );
  await fs.writeFile(
    path.join(factoryDir, "settings.json"),
    JSON.stringify({ enabledPlugins: { "reviewer@official": true } }),
  );
  return { homeDir, marketplacePath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Factory plugin discovery", () => {
  it("lists registered marketplaces and enabled plugins", async () => {
    const fixture = await makeFactoryFixture();
    const result = await listFactoryPlugins(fixture.homeDir);
    expect(result.marketplaces[0]).toMatchObject({
      name: "official",
      path: fixture.marketplacePath,
      interface: { displayName: "Official Factory" },
      plugins: [
        {
          id: "reviewer@official",
          name: "reviewer",
          installed: true,
          enabled: true,
          interface: { displayName: "Reviewer", developerName: "Factory" },
        },
      ],
    });
  });

  it("applies project Factory settings after user-level plugin settings", async () => {
    const fixture = await makeFactoryFixture();
    const cwd = path.join(fixture.homeDir, "workspace");
    await fs.mkdir(path.join(cwd, ".factory"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".factory", "settings.json"),
      JSON.stringify({ enabledPlugins: { "reviewer@official": false } }),
    );
    const result = await listFactoryPlugins(fixture.homeDir, cwd);
    expect(result.marketplaces[0]?.plugins[0]).toMatchObject({
      installed: true,
      enabled: false,
    });
    const detail = await readFactoryPlugin({
      homeDir: fixture.homeDir,
      marketplacePath: fixture.marketplacePath,
      pluginName: "reviewer",
      cwd,
    });
    expect(detail?.plugin.summary).toMatchObject({
      installed: true,
      enabled: false,
    });
  });

  it("reads bundled Factory skills for plugin detail", async () => {
    const fixture = await makeFactoryFixture();
    const result = await readFactoryPlugin({
      homeDir: fixture.homeDir,
      marketplacePath: fixture.marketplacePath,
      pluginName: "reviewer",
    });
    expect(result?.plugin.summary.id).toBe("reviewer@official");
    expect(result?.plugin.skills).toEqual([
      expect.objectContaining({ name: "review", description: "Review code" }),
    ]);
  });

  it("rejects marketplace paths that Factory has not registered", async () => {
    const fixture = await makeFactoryFixture();
    await expect(
      readFactoryPlugin({
        homeDir: fixture.homeDir,
        marketplacePath: path.join(fixture.homeDir, "unregistered"),
        pluginName: "reviewer",
      }),
    ).resolves.toBeNull();
  });
});
