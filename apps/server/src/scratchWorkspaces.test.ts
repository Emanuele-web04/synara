// FILE: scratchWorkspaces.test.ts
// Purpose: Verifies per-thread scratch workspace paths stay inside the shared
//          temp root even when thread ids contain path-like characters.
// Layer: Server filesystem utility tests

import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";
import { describe, expect, it } from "vitest";

import { ensureIsolatedScratchWorkspace } from "./scratchWorkspaces";

function scratchRoot(): string {
  return path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME);
}

describe("ensureIsolatedScratchWorkspace", () => {
  it("creates a readable per-thread directory under the scratch root", () => {
    const workspace = ensureIsolatedScratchWorkspace(ThreadId.makeUnsafe("thread-1"));
    try {
      expect(workspace).toContain(`${path.sep}${SCRATCH_WORKSPACES_DIRNAME}${path.sep}thread-1-`);
      expect(path.relative(scratchRoot(), workspace).startsWith("..")).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not let path-like thread ids escape the scratch root", () => {
    const workspace = ensureIsolatedScratchWorkspace(ThreadId.makeUnsafe("../outside/thread"));
    try {
      const relative = path.relative(scratchRoot(), workspace);
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(workspace).not.toContain(`${path.sep}..${path.sep}`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("uses owner-only permissions on POSIX", () => {
    const workspace = ensureIsolatedScratchWorkspace(ThreadId.makeUnsafe("private-thread"));
    try {
      expect(statSync(workspace).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "tightens permissions when reusing an existing scratch workspace",
    () => {
      const threadId = ThreadId.makeUnsafe("reused-private-thread");
      const workspace = ensureIsolatedScratchWorkspace(threadId);
      try {
        chmodSync(workspace, 0o755);
        expect(statSync(workspace).mode & 0o777).toBe(0o755);

        expect(ensureIsolatedScratchWorkspace(threadId)).toBe(workspace);
        expect(statSync(workspace).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens permissions when reusing the shared scratch root",
    () => {
      const workspace = ensureIsolatedScratchWorkspace(ThreadId.makeUnsafe("private-root"));
      try {
        chmodSync(scratchRoot(), 0o777);

        ensureIsolatedScratchWorkspace(ThreadId.makeUnsafe("private-root"));

        expect(statSync(scratchRoot()).mode & 0o777).toBe(0o700);
      } finally {
        chmodSync(scratchRoot(), 0o700);
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to follow a reused scratch workspace symlink",
    () => {
      const threadId = ThreadId.makeUnsafe("symlinked-private-thread");
      const workspace = ensureIsolatedScratchWorkspace(threadId);
      const redirected = mkdtempSync(path.join(tmpdir(), "synara-scratch-redirect-"));
      rmSync(workspace, { recursive: true, force: true });
      symlinkSync(redirected, workspace, "dir");
      try {
        expect(() => ensureIsolatedScratchWorkspace(threadId)).toThrow(
          /open without following symlinks/,
        );
      } finally {
        rmSync(workspace, { force: true });
        rmSync(redirected, { recursive: true, force: true });
      }
    },
  );
});
