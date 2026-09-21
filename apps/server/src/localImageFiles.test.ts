import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { resolveAllowedLocalPreviewFile } from "./localImageFiles.ts";

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
  it("allows images inside the current workspace", async () => {
    const workspace = makeTempDir("synara-image-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const imagePath = path.join(workspace, "preview.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(imagePath));
    assert.equal(result?.fileName, "preview.png");
  });

  it("allows images inside Codex generated_images without a cwd", async () => {
    const codexHome = makeTempDir("synara-codex-home-");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const imageDir = path.join(codexHome, "generated_images", "provider-thread");
      const imagePath = path.join(imageDir, "call.png");
      mkdirSync(imageDir, { recursive: true });
      writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("allows images written to the SYNARA_HOME codex-home-overlay generated_images root", async () => {
    // app-server runs with CODEX_HOME pointing at the Synara overlay, so images live outside both ~/.codex and any workspace root — the allowlist must still serve them
    // anchor fake homes inside the worktree so neither path falls under os.tmpdir() — only the overlay candidate can satisfy the allowlist
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

  it("allows PDFs inside the current workspace", async () => {
    const workspace = makeTempDir("synara-pdf-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "docs", "spec.pdf");
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
    // sessions starting before a project workspace exists run in <tmpdir>/synara-codex-workspaces/<threadId> — files agents create there are workspace-equivalent
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
      // remove only the per-thread dir — the shared scratch root may belong to a live server
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
    // temp/generated-image roots exist for agent-produced images in chat markdown — documents must only be served from the workspace
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
