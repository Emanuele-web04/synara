import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuildConfig, DESKTOP_PACKAGE_METADATA } from "./build-desktop-artifact.ts";
import { createDesktopArtifactIdentity } from "./lib/desktop-artifact-identity.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Linux desktop artifact packaging", () => {
  it.each(["production", "beta"] as const)(
    "builds both formats with one AppImage-owned feed for %s",
    async (flavor) => {
      vi.stubEnv("SYNARA_DESKTOP_UPDATE_REPOSITORY", "Emanuele-web04/synara");
      const result = await Effect.runPromise(
        createBuildConfig(
          "linux",
          "AppImage,deb",
          createDesktopArtifactIdentity({ platform: "linux", flavor }),
          false,
          false,
          undefined,
          flavor,
        ),
      );
      expect(result.buildConfig.linux).toMatchObject({
        target: ["AppImage", "deb"],
        executableName: flavor === "beta" ? "synara-beta" : "synara",
      });
      expect(result.buildConfig.appId).toBe(
        flavor === "beta" ? "com.emanueledipietro.synara.beta" : "com.emanueledipietro.synara",
      );
      expect(result.buildConfig.publish).toEqual([
        { provider: "github", owner: "Emanuele-web04", repo: "synara", releaseType: "release" },
      ]);
      expect(result.buildConfig.deb).toEqual({ publish: null });
      // Exercise the installed electron-builder implementation, not a mock of
      // target-level publish semantics: only AppImage events may produce metadata.
      const requireScripts = createRequire(new URL("./package.json", import.meta.url));
      const requireBuilder = createRequire(requireScripts.resolve("electron-builder"));
      const requireAppBuilder = createRequire(requireBuilder.resolve("app-builder-lib"));
      const { getPublishConfigs } = requireAppBuilder("./publish/PublishManager.js") as {
        getPublishConfigs: (
          packager: unknown,
          target: unknown,
          arch: number,
          errorIfCannot: boolean,
        ) => Promise<unknown>;
      };
      const packager = {
        platformSpecificBuildOptions: result.buildConfig.linux,
        config: result.buildConfig,
      };
      expect(await getPublishConfigs(packager, result.buildConfig.deb, 1, true)).toBeNull();
    },
  );

  it("does not emit a feed for a standalone Debian build", async () => {
    vi.stubEnv("SYNARA_DESKTOP_UPDATE_REPOSITORY", "Emanuele-web04/synara");
    const result = await Effect.runPromise(
      createBuildConfig(
        "linux",
        "deb",
        createDesktopArtifactIdentity({ platform: "linux", flavor: "production" }),
        false,
        false,
        undefined,
        "production",
      ),
    );
    expect(result.buildConfig.linux).toMatchObject({ target: ["deb"] });
    expect(result.buildConfig.publish).toBeNull();
    expect(DESKTOP_PACKAGE_METADATA).toEqual({
      author: { name: "Emanuele Di Pietro", email: "feedback@trysynara.com" },
      homepage: "https://www.trysynara.com",
    });
  });

  it.each(["", "AppImage,", "deb,deb", "AppImage,rpm", "unknown"])(
    "rejects invalid CLI target %j before any staging or build",
    (target) => {
      const result = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "build-desktop-artifact.ts"),
          "--platform",
          "linux",
          "--target",
          target,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/Linux package target/);
      expect(result.stdout + result.stderr).not.toContain("Packaging stage:");
    },
  );

  it("rejects combined Linux targets on another platform", () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "build-desktop-artifact.ts"),
        "--platform",
        "mac",
        "--target",
        "AppImage,deb",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Multiple artifact targets are supported only for Linux",
    );
  });

  it("applies the same target validation to the environment fallback", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "build-desktop-artifact.ts"), "--platform", "linux"],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, SYNARA_DESKTOP_TARGET: "deb,deb" },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Linux package targets must be unique");
    expect(result.stdout + result.stderr).not.toContain("Packaging stage:");
  });
});
