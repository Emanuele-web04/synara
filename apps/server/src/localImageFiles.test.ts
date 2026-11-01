import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { execProcessFile } from "@synara/shared/processRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { ServerConfig } from "./config";
import { GitCoreLive } from "./git/Layers/GitCore";
import { listLocalPreviewWorktreeRoots } from "./workspace/localPreviewWorktrees";

import { resolveCodexHomeOverlayAccountSegment } from "./codexHomePaths.ts";
import { createLocalPreviewGrant, resolveAllowedLocalPreviewFile } from "./localImageFiles.ts";

const PreviewGitLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "synara-preview-git-" })),
  Layer.provide(NodeServices.layer),
);

const previewWorktrees = (cwd: string) =>
  Effect.runPromise(listLocalPreviewWorktreeRoots({ cwd }).pipe(Effect.provide(PreviewGitLayer)));

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveAllowedLocalPreviewFile", () => {
  it("does not fall back to ambient Codex homes when the allowlist is intentionally empty", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-empty-allowlist-${process.pid}-${Date.now()}`,
    );
    const codexHome = path.join(fakeRoot, ".codex-disabled");
    const imageDir = path.join(codexHome, "generated_images", "provider-thread");
    const imagePath = path.join(imageDir, "call.png");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePaths: [],
      });

      assert.equal(result, null);
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("allows images written to the SYNARA_HOME codex-home-overlay generated_images root", async () => {
    // Codex app-server is launched with CODEX_HOME pointing at a Synara overlay
    // directory (see resolveSynaraCodexHomeOverlayPath). Generated images therefore
    // live under <SYNARA_HOME>/codex-home-overlay/generated_images/<thread>/<call>.png,
    // which sits outside both the user's `~/.codex` source home and any workspace
    // root. The allowlist must still serve them.
    //
    // We anchor the fake homes inside the worktree (process.cwd() resolves to
    // apps/server/ when vitest runs) so neither path falls under os.tmpdir(); that
    // way only the overlay candidate can satisfy the allowlist.
    const fakeRoot = path.join(process.cwd(), `.test-codex-overlay-${process.pid}-${Date.now()}`);
    const sourceHome = path.join(fakeRoot, "source", ".codex");
    const synaraHome = path.join(fakeRoot, "synara", "runtime");
    const overlayImageDir = path.join(
      synaraHome,
      "codex-home-overlay",
      "generated_images",
      "thread-overlay",
    );
    const imagePath = path.join(overlayImageDir, "call.png");
    mkdirSync(overlayImageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousSynaraHome = process.env.SYNARA_HOME;
    process.env.SYNARA_HOME = synaraHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePath: sourceHome,
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousSynaraHome === undefined) {
        delete process.env.SYNARA_HOME;
      } else {
        process.env.SYNARA_HOME = previousSynaraHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects generated images from sibling Codex account overlays", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-account-overlay-${process.pid}-${Date.now()}`,
    );
    const sourceHome = path.join(fakeRoot, "source", ".codex");
    const synaraHome = path.join(fakeRoot, "synara", "runtime");
    const siblingImageDir = path.join(
      synaraHome,
      "codex-home-overlay",
      "accounts",
      "work-account",
      "generated_images",
      "thread-work",
    );
    const imagePath = path.join(siblingImageDir, "call.png");
    mkdirSync(siblingImageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousSynaraHome = process.env.SYNARA_HOME;
    process.env.SYNARA_HOME = synaraHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePath: sourceHome,
      });

      assert.equal(result, null);
    } finally {
      if (previousSynaraHome === undefined) {
        delete process.env.SYNARA_HOME;
      } else {
        process.env.SYNARA_HOME = previousSynaraHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects generated_images roots that symlink outside the configured Codex home", async () => {
    if (process.platform === "win32") return;
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-symlinked-images-${process.pid}-${Date.now()}`,
    );
    tempDirs.push(fakeRoot);
    const codexHome = path.join(fakeRoot, "codex-home");
    const outsideRoot = path.join(fakeRoot, "outside");
    const imagePath = path.join(outsideRoot, "thread", "call.png");
    mkdirSync(path.dirname(imagePath), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    symlinkSync(outsideRoot, path.join(codexHome, "generated_images"), "dir");

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: null,
      codexHomePaths: [codexHome],
    });

    assert.equal(result, null);
  });

  it("allows generated images from the configured Codex account overlay", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-configured-account-overlay-${process.pid}-${Date.now()}`,
    );
    const sourceHome = path.join(fakeRoot, "source", ".codex-work");
    const shadowHome = path.join(fakeRoot, "shadow", ".codex-work-auth");
    const synaraHome = path.join(fakeRoot, "synara", "runtime");
    const accountSegment = resolveCodexHomeOverlayAccountSegment({
      homePath: sourceHome,
      shadowHomePath: shadowHome,
      accountId: "work",
    });
    assert.ok(accountSegment, "expected an account overlay segment");
    const imageDir = path.join(
      synaraHome,
      "codex-home-overlay",
      "accounts",
      accountSegment,
      "generated_images",
      "thread-work",
    );
    const imagePath = path.join(imageDir, "call.png");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousSynaraHome = process.env.SYNARA_HOME;
    process.env.SYNARA_HOME = synaraHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePaths: [
          {
            homePath: sourceHome,
            shadowHomePath: shadowHome,
            accountId: "work",
          },
        ],
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousSynaraHome === undefined) {
        delete process.env.SYNARA_HOME;
      } else {
        process.env.SYNARA_HOME = previousSynaraHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("allows PDFs inside dot-prefixed workspace directories", async () => {
    const workspace = makeTempDir("synara-pdf-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "..assets", "spec.pdf");
    mkdirSync(path.dirname(pdfPath), { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(pdfPath));
    assert.equal(result?.fileName, "spec.pdf");
    assert.equal(result?.sizeBytes, 8);
  });

  it("allows PDFs inside a per-thread scratch workspace without a cwd", async () => {
    // Sessions that start before a project workspace exists run in
    // <tmpdir>/synara-codex-workspaces/<threadId>; files agents create there
    // are workspace-equivalent, so documents must be servable from that root.
    const scratchRoot = path.join(os.tmpdir(), "synara-codex-workspaces");
    const threadDir = path.join(scratchRoot, `test-thread-${process.pid}-${Date.now()}`);
    const pdfPath = path.join(threadDir, "viewer-test.pdf");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: pdfPath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync(pdfPath));
      assert.equal(result?.fileName, "viewer-test.pdf");
      assert.equal(result?.sizeBytes, 8);
    } finally {
      // Remove only the per-thread dir — the shared scratch root may belong
      // to a live server.
      rmSync(threadDir, { recursive: true, force: true });
    }
  });

  it("allows PDFs inside the configured private scratch root without a cwd", async () => {
    const privateTempRoot = makeTempDir("synara-private-scratch-");
    const scratchRoot = path.join(privateTempRoot, "synara-codex-workspaces");
    const threadDir = path.join(scratchRoot, "private-thread");
    const pdfPath = path.join(threadDir, "private-scratch.pdf");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: null,
      scratchWorkspacesRoot: scratchRoot,
    });

    assert.equal(result?.path, realpathSync(pdfPath));
    assert.equal(result?.fileName, "private-scratch.pdf");
  });

  it("rejects PDFs outside the workspace even under the temp-dir image roots", async () => {
    // Temp/generated-image roots exist for agent-produced images in chat
    // markdown; documents must only ever be served from the workspace.
    const tempDir = makeTempDir("synara-pdf-outside-");
    const pdfPath = path.join(tempDir, "leak.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: null,
    });

    assert.equal(result, null);
  });

  it("still allows images under the temp-dir roots without a workspace", async () => {
    const tempDir = makeTempDir("synara-image-tmp-root-");
    const imagePath = path.join(tempDir, "clip.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: null,
    });

    assert.equal(result?.path, realpathSync(imagePath));
  });

  it("rejects unsupported paths", async () => {
    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: "/etc/hosts",
      cwd: null,
    });

    assert.equal(result, null);
  });
});

// Grant recovery is the policy owner: exercise real worktree registrations, not
// a root list that would grant an unrelated sibling by construction.
function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execProcessFile("git", args, { cwd, timeout: 5_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

async function makePreviewWorktree() {
  const homeDir = mkdtempSync(path.join(process.cwd(), ".preview-grant-"));
  tempDirs.push(homeDir);
  const cwd = path.join(homeDir, "project");
  const worktree = path.join(homeDir, "linked");
  mkdirSync(cwd);
  await runGit(cwd, ["init", "--quiet"]);
  await runGit(cwd, ["config", "core.hooksPath", path.join(cwd, ".git", "hooks")]);
  await runGit(cwd, [
    "-c",
    "user.name=Preview Test",
    "-c",
    "user.email=preview@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await runGit(cwd, ["worktree", "add", "--quiet", "--detach", worktree]);
  const worktreeRoots = await previewWorktrees(cwd);
  return { cwd, worktree, homeDir, worktreeRoots };
}

describe("createLocalPreviewGrant relative recovery", () => {
  it("canonicalizes a registered sibling worktree and grants only the referenced file", async () => {
    const context = await makePreviewWorktree();
    const imagePath = path.join(context.worktree, "result.png");
    const otherPath = path.join(context.worktree, "other.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(otherPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await createLocalPreviewGrant({
      requestedPath: "../linked/result.png",
      ...context,
    });
    assert.equal(result.canonicalPath, realpathSync(imagePath));
    const preview = (requestedPath: string) =>
      resolveAllowedLocalPreviewFile({
        requestedPath,
        cwd: context.cwd,
        previewGrant: result.grant,
        allowAbsoluteLocalPreviewFile: true,
        codexHomePaths: [],
      });
    assert.equal((await preview(result.canonicalPath))?.path, realpathSync(imagePath));
    assert.equal(await preview(otherPath), null);
  });

  it("does not turn parent paths, unrelated repositories or symlinks into workspace access", async () => {
    const context = await makePreviewWorktree();
    writeFileSync(path.join(context.worktree, "result.png"), "registered");
    const unrelated = path.join(context.homeDir, "unrelated");
    mkdirSync(unrelated);
    await runGit(unrelated, ["init", "--quiet"]);
    writeFileSync(path.join(unrelated, "private.png"), "private");
    writeFileSync(path.join(context.homeDir, "private.png"), "private");
    if (process.platform !== "win32") {
      symlinkSync(unrelated, path.join(context.worktree, "escape"), "dir");
      symlinkSync(path.join(unrelated, "private.png"), path.join(context.cwd, "escape.png"));
    }
    const refused = ["../private.png", "../unrelated/private.png"];
    if (process.platform !== "win32") refused.push("../linked/escape/private.png", "escape.png");
    for (const requestedPath of refused) {
      await assert.rejects(createLocalPreviewGrant({ requestedPath, ...context }));
    }
    // Even a .git pointer to a real repository must not authorize an unregistered cwd.
    const impostor = path.join(context.homeDir, "impostor");
    mkdirSync(impostor);
    writeFileSync(path.join(impostor, ".git"), `gitdir: ${path.join(context.cwd, ".git")}`);
    const impostorRoots = await previewWorktrees(impostor);
    assert.deepEqual(impostorRoots, []);
    await assert.rejects(
      createLocalPreviewGrant({
        ...context,
        cwd: impostor,
        worktreeRoots: impostorRoots,
        requestedPath: "../linked/result.png",
      }),
    );
  });

  it("keeps absolute clients and safe in-root or existing ancestor recovery compatible", async () => {
    const homeDir = makeTempDir("synara-preview-context-");
    const cwd = path.join(homeDir, "project", "nested");
    const ancestorFile = path.join(homeDir, "project", "shared.png");
    const inRoot = path.join(cwd, "inside.png");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(ancestorFile, "ancestor");
    writeFileSync(inRoot, "inside");
    for (const [requestedPath, expected] of [
      ["inside.png", inRoot],
      ["shared.png", ancestorFile],
      [inRoot, inRoot],
    ] as const) {
      const result = await createLocalPreviewGrant({ requestedPath, cwd, homeDir });
      assert.equal(result.canonicalPath, realpathSync(expected));
    }
    await assert.rejects(createLocalPreviewGrant({ requestedPath: "inside.png" }));
  });
});
