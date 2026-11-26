// FILE: betaFeatureGate.test.ts
// Purpose: Verify the server host's shared feature policy: UI locale has no server mutation RPC,
//          and Canvas (Beta only) adds no turn context on a Stable host.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadId } from "@synara/contracts";
import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";
import { CHINESE_UI_BETA_FEATURE, DESIGN_CANVAS_BETA_FEATURE } from "@synara/shared/betaFeatures";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it.each([
  [SYNARA_PRODUCTION_BUNDLE_ID, false],
  [SYNARA_BETA_BUNDLE_ID, true],
] as const)(
  "uses the host bundle identity for Chinese UI feature availability (%s)",
  async (bundleId, enabled) => {
    vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, bundleId);
    vi.resetModules();
    const { isServerBetaFeatureEnabled } = await import("./betaFeatureGate");
    expect(isServerBetaFeatureEnabled(CHINESE_UI_BETA_FEATURE)).toBe(enabled);
  },
);

it.each([
  [SYNARA_PRODUCTION_BUNDLE_ID, false],
  [SYNARA_BETA_BUNDLE_ID, true],
] as const)(
  "keeps Canvas off on a Stable host, with no canvas context for a linked chat (%s)",
  async (bundleId, enabled) => {
    vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, bundleId);
    vi.resetModules();
    const { isServerBetaFeatureEnabled } = await import("./betaFeatureGate");
    expect(isServerBetaFeatureEnabled(DESIGN_CANVAS_BETA_FEATURE)).toBe(enabled);
    // A chat linked to a work, as an agent's synara_create_canvas leaves it.
    const directory = await mkdtemp(path.join(tmpdir(), "synara-canvas-gate-"));
    directories.push(directory);
    const threadId = ThreadId.makeUnsafe("linked-chat");
    const { makeCanvasLibraryStore } = await import("./canvasLibraryStore");
    await makeCanvasLibraryStore(directory).create(
      { id: "work", title: "Work" },
      undefined,
      threadId,
    );
    const { canvasTurnContext } = await import("./canvasTurnContext");
    const context = await canvasTurnContext(directory, threadId);
    if (enabled) expect(context).toContain('workId="work"');
    else expect(context).toBe("");
  },
);
