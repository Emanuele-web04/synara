import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig, type InlineConfig } from "vite";

import viteConfig from "../vite.config";

const REACT_COMPILER_PLUGIN = "@rolldown/plugin-babel";
const REACT_FAST_REFRESH_PLUGIN = "vite:react-refresh";

function inlineWebConfig(): InlineConfig {
  return {
    ...viteConfig,
    // Resolve the imported config directly. Letting Vite discover the config file again would merge a second copy of every plugin into this test.
    configFile: false,
    plugins: viteConfig.plugins ? [...viteConfig.plugins] : [],
  };
}

async function resolveWebPluginNames(command: "build" | "serve", mode: string) {
  const resolved = await resolveConfig(inlineWebConfig(), command, mode);
  return resolved.plugins.map((plugin) => plugin.name);
}

describe("web Vite React Compiler activation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "0", "false", "yes"])(
    "keeps the compiler out of serve with flag %s while retaining Fast Refresh",
    async (flag) => {
      vi.stubEnv("SYNARA_DEV_REACT_COMPILER", flag);

      const pluginNames = await resolveWebPluginNames("serve", "development");

      expect(pluginNames).not.toContain(REACT_COMPILER_PLUGIN);
      expect(pluginNames).toContain(REACT_FAST_REFRESH_PLUGIN);
    },
  );

  it("keeps the compiler in production builds when the development flag is disabled", async () => {
    vi.stubEnv("SYNARA_DEV_REACT_COMPILER", "0");

    const pluginNames = await resolveWebPluginNames("build", "production");

    expect(pluginNames).toContain(REACT_COMPILER_PLUGIN);
  });

  it("keeps the compiler in test mode when the development flag is disabled", async () => {
    vi.stubEnv("SYNARA_DEV_REACT_COMPILER", "0");

    const pluginNames = await resolveWebPluginNames("serve", "test");

    expect(pluginNames).toContain(REACT_COMPILER_PLUGIN);
  });

  it.each(["1", "true", " TRUE "])("allows %s to opt the compiler into serve", async (flag) => {
    vi.stubEnv("SYNARA_DEV_REACT_COMPILER", flag);

    const pluginNames = await resolveWebPluginNames("serve", "development");

    expect(pluginNames).toContain(REACT_COMPILER_PLUGIN);
  });
});
