// FILE: betaInstaller.test.ts
// Purpose: Unit coverage for the beta feed parser, arch selection, and
//          checksum/bundle-identity gates in the macOS auto-install flow.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  httpsFetchText,
  installBetaFromFeed,
  parseBetaMacManifest,
  resolveBetaFeedLocation,
  selectBetaDownloadFile,
  verifyBetaAppBundle,
  type BetaFeedFile,
} from "./betaInstaller";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-beta-installer-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

const MANIFEST = `
version: 0.9.3-beta.1
files:
  - url: Synara-Beta-0.9.3-beta.1-arm64-mac.zip
    sha512: aaa=
    size: 100
  - url: Synara-Beta-0.9.3-beta.1-arm64.dmg
    sha512: bbb=
    size: 200
path: Synara-Beta-0.9.3-beta.1-arm64-mac.zip
sha512: aaa=
releaseDate: '2026-09-23T00:00:00.000Z'
`;

describe("parseBetaMacManifest", () => {
  it("parses version and files from an electron-builder manifest", () => {
    const manifest = parseBetaMacManifest(MANIFEST);
    expect(manifest.version).toBe("0.9.3-beta.1");
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0]).toEqual({
      url: "Synara-Beta-0.9.3-beta.1-arm64-mac.zip",
      sha512: "aaa=",
      size: 100,
    });
  });

  it("rejects a manifest without version or files", () => {
    expect(() => parseBetaMacManifest("not: a manifest\n")).toThrow(/missing version or files/);
    expect(() => parseBetaMacManifest("version: 1.0.0\n")).toThrow(/missing version or files/);
  });
});

describe("selectBetaDownloadFile", () => {
  const files: BetaFeedFile[] = [
    { url: "Synara-Beta-1.0.0-beta.1-arm64-mac.zip", sha512: "a" },
    { url: "Synara-Beta-1.0.0-beta.1-x64-mac.zip", sha512: "b" },
    { url: "Synara-Beta-1.0.0-beta.1-arm64.dmg", sha512: "c" },
  ];

  it("picks the zip matching the build arch", () => {
    expect(selectBetaDownloadFile(files, "arm64").sha512).toBe("a");
    expect(selectBetaDownloadFile(files, "x64").sha512).toBe("b");
  });

  it("accepts a single unmarked zip", () => {
    const single = [{ url: "Synara-Beta-1.0.0-beta.1-mac.zip", sha512: "s" }];
    expect(selectBetaDownloadFile(single, "arm64").sha512).toBe("s");
  });

  it("fails closed when no zip matches the arch", () => {
    expect(() => selectBetaDownloadFile(files, "ppc")).toThrow(/No beta download/);
    expect(() => selectBetaDownloadFile([{ url: "app.dmg", sha512: "d" }], "arm64")).toThrow(
      /No beta download/,
    );
  });
});

describe("resolveBetaFeedLocation", () => {
  it("uses the override base URL verbatim", async () => {
    const location = await resolveBetaFeedLocation({
      feedUrlOverride: "http://127.0.0.1:8799/feed",
    });
    expect(location.manifestUrl).toBe("http://127.0.0.1:8799/feed/beta-mac.yml");
    expect(location.baseUrl).toBe("http://127.0.0.1:8799/feed/");
  });

  it("picks the newest beta release with a manifest asset", async () => {
    const location = await resolveBetaFeedLocation({
      fetchText: async () =>
        JSON.stringify([
          { tag_name: "v0.9.4", assets: [{ name: "latest-mac.yml" }] },
          {
            tag_name: "v0.9.3-beta.2",
            assets: [
              {
                name: "beta-mac.yml",
                browser_download_url:
                  "https://github.com/x/releases/download/v0.9.3-beta.2/beta-mac.yml",
              },
            ],
          },
        ]),
    });
    expect(location.manifestUrl).toBe(
      "https://github.com/x/releases/download/v0.9.3-beta.2/beta-mac.yml",
    );
    expect(location.baseUrl).toBe("https://github.com/x/releases/download/v0.9.3-beta.2/");
  });

  it("throws when no beta release carries the manifest", async () => {
    await expect(
      resolveBetaFeedLocation({
        fetchText: async () => JSON.stringify([{ tag_name: "v1.0.0", assets: [] }]),
      }),
    ).rejects.toThrow(/No beta release/);
  });
});

function fakeApp(dir: string, bundleId = "com.emanueledipietro.synara.beta"): string {
  const appPath = join(dir, "Synara Beta.app", "Contents");
  mkdirSync(appPath, { recursive: true });
  writeFileSync(
    join(appPath, "Info.plist"),
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`,
  );
  return join(dir, "Synara Beta.app");
}

const noTeamIdReadCommand = () => ({ status: 0, stdout: "", stderr: "Executable=/tmp/x\n" });

describe("verifyBetaAppBundle", () => {
  it("accepts the beta bundle id", () => {
    const root = makeRoot();
    expect(() => verifyBetaAppBundle(fakeApp(root))).not.toThrow();
  });

  it("rejects a non-beta bundle id", () => {
    const root = makeRoot();
    expect(() => verifyBetaAppBundle(fakeApp(root, "com.emanueledipietro.synara"))).toThrow(
      /not Synara Beta/,
    );
  });

  it("rejects a missing app", () => {
    const root = makeRoot();
    expect(() => verifyBetaAppBundle(join(root, "Nope.app"))).toThrow(/did not contain/);
  });
});

describe("installBetaFromFeed", () => {
  const zipBytes = Buffer.from("fake-zip-bytes");
  const zipSha512 = createHash("sha512").update(zipBytes).digest("base64");

  function feedDeps(root: string) {
    const installDir = join(root, "Applications");
    return {
      installDir,
      deps: {
        arch: "arm64",
        installDir,
        feedUrlOverride: "http://127.0.0.1:1/feed",
        tempBaseDir: root,
        fetchText: async (url: string) => {
          expect(url).toBe("http://127.0.0.1:1/feed/beta-mac.yml");
          return `version: 0.9.3-beta.1\nfiles:\n  - url: beta.zip\n    sha512: ${zipSha512}\n`;
        },
        downloadFile: async (_url: string, dest: string) => {
          writeFileSync(dest, zipBytes);
        },
        run: (command: string, args: readonly string[]) => {
          if (command === "ditto") {
            fakeApp(args[args.length - 1]!);
            return;
          }
          if (command === "mv") {
            mkdirSync(args[args.length - 1]!, { recursive: true });
            return;
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    };
  }

  it("downloads, verifies, extracts, and installs the bundle", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const phases: string[] = [];
    const target = await installBetaFromFeed(deps, (p) => phases.push(p.phase));
    expect(target).toBe(join(installDir, "Synara Beta.app"));
    expect(existsSync(target)).toBe(true);
    expect(phases).toEqual(["downloading", "verifying", "installing"]);
  });

  it("fails closed on a sha512 mismatch", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const bad = {
      ...deps,
      fetchText: async () =>
        `version: 0.9.3-beta.1\nfiles:\n  - url: beta.zip\n    sha512: ${"0".repeat(88)}=\n`,
    };
    await expect(installBetaFromFeed(bad, () => {})).rejects.toThrow(/checksum/);
    expect(existsSync(join(installDir, "Synara Beta.app"))).toBe(false);
  });

  it("fails closed when the zip contains a non-beta bundle", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const bad = {
      ...deps,
      run: (command: string, args: readonly string[]) => {
        if (command === "ditto") {
          fakeApp(args[args.length - 1]!, "com.emanueledipietro.synara");
          return;
        }
        if (command === "mv") return;
        throw new Error(`unexpected command ${command}`);
      },
    };
    await expect(installBetaFromFeed(bad, () => {})).rejects.toThrow(/not Synara Beta/);
    expect(existsSync(join(installDir, "Synara Beta.app"))).toBe(false);
  });

  it("replaces an existing install without leaving the old app behind", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    fakeApp(installDir);
    await installBetaFromFeed(deps, () => {});
    expect(readdirSync(installDir)).toEqual(["Synara Beta.app"]);
  });

  it("keeps the installed app when moving the new one into place fails", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const installed = fakeApp(installDir);
    const failingMove = {
      ...deps,
      run: (command: string, args: readonly string[]) => {
        if (command === "mv") {
          // A cross-device `mv` that dies mid-copy leaves a partial target behind.
          mkdirSync(args[args.length - 1]!, { recursive: true });
          throw new Error("mv: No space left on device");
        }
        deps.run(command, args);
      },
    };
    await expect(installBetaFromFeed(failingMove, () => {})).rejects.toThrow(/No space left/);
    expect(() => verifyBetaAppBundle(installed)).not.toThrow();
    expect(readdirSync(installDir)).toEqual(["Synara Beta.app"]);
  });

  const codesignStub = (teamId: string | null, verifyOk = true) => {
    const calls: string[][] = [];
    return {
      calls,
      readCommand: (command: string, args: readonly string[]) => {
        expect(command).toBe("codesign");
        calls.push([...args]);
        if (args[0] === "--verify") {
          return { status: verifyOk ? 0 : 1, stdout: "", stderr: verifyOk ? "" : "invalid" };
        }
        // codesign -dv prints TeamIdentifier on stderr.
        return {
          status: 0,
          stdout: "",
          stderr: teamId === null ? "TeamIdentifier=not set\n" : `TeamIdentifier=${teamId}\n`,
        };
      },
    };
  };

  it("installs when the download is signed by the expected team", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const { calls, readCommand } = codesignStub("TEAM1234AB");
    const target = await installBetaFromFeed(
      { ...deps, expectedTeamId: "TEAM1234AB", readCommand },
      () => {},
    );
    expect(target).toBe(join(installDir, "Synara Beta.app"));
    expect(calls).toHaveLength(2);
  });

  it("rejects a bundle signed by a different team", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const { readCommand } = codesignStub("OTHER9999");
    await expect(
      installBetaFromFeed({ ...deps, expectedTeamId: "TEAM1234AB", readCommand }, () => {}),
    ).rejects.toThrow("The beta download isn't signed by Synara. It wasn't installed.");
    expect(existsSync(join(installDir, "Synara Beta.app"))).toBe(false);
  });

  it("rejects a bundle whose signature fails verification", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const { readCommand } = codesignStub("TEAM1234AB", false);
    await expect(
      installBetaFromFeed({ ...deps, expectedTeamId: "TEAM1234AB", readCommand }, () => {}),
    ).rejects.toThrow(/isn't signed by Synara/);
    expect(existsSync(join(installDir, "Synara Beta.app"))).toBe(false);
  });

  it("rejects a bundle with no TeamIdentifier line", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    await expect(
      installBetaFromFeed(
        { ...deps, expectedTeamId: "TEAM1234AB", readCommand: noTeamIdReadCommand },
        () => {},
      ),
    ).rejects.toThrow(/isn't signed by Synara/);
    expect(existsSync(join(installDir, "Synara Beta.app"))).toBe(false);
  });

  it("skips codesign entirely when the running app is unsigned", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const { calls, readCommand } = codesignStub(null);
    const target = await installBetaFromFeed(
      { ...deps, expectedTeamId: null, readCommand },
      () => {},
    );
    expect(target).toBe(join(installDir, "Synara Beta.app"));
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the running app's own team id is unavailable", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const { calls, readCommand } = codesignStub("TEAM1234AB");
    await expect(
      installBetaFromFeed({ ...deps, expectedTeamId: "unavailable", readCommand }, () => {}),
    ).rejects.toThrow(
      "Couldn't check the beta download's signature. Try the download page instead.",
    );
    expect(calls).toHaveLength(0);
    expect(existsSync(join(installDir, "Synara Beta.app"))).toBe(false);
  });

  it("rejects a symlinked bundle", async () => {
    const root = makeRoot();
    const { deps, installDir } = feedDeps(root);
    const bad = {
      ...deps,
      run: (command: string, args: readonly string[]) => {
        if (command === "ditto") {
          const extractDir = args[args.length - 1]!;
          const real = fakeApp(join(root, "elsewhere"));
          symlinkSync(real, join(extractDir, "Synara Beta.app"));
          return;
        }
        if (command === "mv") return;
        throw new Error(`unexpected command ${command}`);
      },
    };
    await expect(installBetaFromFeed(bad, () => {})).rejects.toThrow(/isn't signed by Synara/);
    expect(existsSync(join(installDir, "Synara Beta.app"))).toBe(false);
  });
});

describe("httpsFetchText transport policy", () => {
  it("refuses plain HTTP for non-loopback hosts", async () => {
    await expect(httpsFetchText("http://example.com/beta-mac.yml")).rejects.toThrow(/non-loopback/);
  });

  it("refuses non-HTTP protocols", async () => {
    await expect(httpsFetchText("file:///etc/passwd")).rejects.toThrow(/Unsupported/);
  });

  it("rejects after 5 redirects", async () => {
    const server = createServer((request, response) => {
      response.writeHead(302, { location: `${request.url}x` });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await expect(httpsFetchText(`http://127.0.0.1:${port}/a`)).rejects.toThrow(
        "Too many redirects",
      );
    } finally {
      server.close();
    }
  });

  it("accepts plain HTTP from a loopback demo feed", async () => {
    const server = createServer((_request, response) => response.end("version: 1.0.0-beta.1\n"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await expect(httpsFetchText(`http://127.0.0.1:${port}/beta-mac.yml`)).resolves.toBe(
        "version: 1.0.0-beta.1\n",
      );
    } finally {
      server.close();
    }
  });
});
