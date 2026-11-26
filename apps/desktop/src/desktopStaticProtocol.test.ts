import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { createDesktopStaticProtocolResolver } from "./desktopStaticProtocol";

const staticRoot = Path.resolve("/virtual/synara-static");
const rootIndex = Path.join(staticRoot, "index.html");

function resolverWithExistingPaths(paths: ReadonlyArray<string>) {
  const existingPaths = new Set(paths.map((entry) => Path.resolve(entry)));
  return createDesktopStaticProtocolResolver(staticRoot, (candidate) =>
    existingPaths.has(Path.resolve(candidate)),
  );
}

describe("createDesktopStaticProtocolResolver", () => {
  it("resolves an existing asset inside the static root", () => {
    const assetPath = Path.join(staticRoot, "assets", "app.js");
    const resolveRequest = resolverWithExistingPaths([rootIndex, assetPath]);

    expect(resolveRequest("synara://app/assets/app.js")).toEqual({ path: assetPath });
  });

  it("keeps HEAD navigation and paths with API-like names in the SPA", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("synara://app/thread/missing", "HEAD")).toEqual({ path: rootIndex });
    expect(resolveRequest("synara://app/api-reference")).toEqual({ path: rootIndex });
  });

  it.each(["POST", "OPTIONS"])(
    "refuses %s instead of serving a successful static response",
    (method) => {
      const assetPath = Path.join(staticRoot, "assets", "app.js");
      const resolveRequest = resolverWithExistingPaths([rootIndex, assetPath]);

      expect(resolveRequest("synara://app/api/attachments/upload?name=photo.png", method)).toEqual({
        error: -6,
      });
      expect(resolveRequest("synara://app/assets/app.js", method)).toEqual({ error: -6 });
    },
  );

  it.each([
    "/api",
    "/api/attachments/upload?name=photo.png",
    "/api/remote/resource/host",
    "/attachments/att_v2_example.png",
    "/ws",
    "/v2/resource",
    "/%61pi/attachments/upload",
    "/api%2Fattachments%2Fupload",
    "/folder%2F..%2Fapi/attachments/upload",
    "/api%5Cattachments%5Cupload",
    "/api/%E0%A4%A",
  ])("refuses backend resource %s before any SPA fallback", (resourcePath) => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest(`synara://app${resourcePath}`)).toEqual({ error: -6 });
  });

  it("returns Electron file-not-found for a missing asset", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("synara://app/assets/missing.js")).toEqual({ error: -6 });
  });

  it("resolves an extensionless route to its existing nested index", () => {
    const nestedIndex = Path.join(staticRoot, "settings", "index.html");
    const resolveRequest = resolverWithExistingPaths([rootIndex, nestedIndex]);

    expect(resolveRequest("synara://app/settings")).toEqual({ path: nestedIndex });
  });

  it("falls back to the root index for a missing navigation route", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("synara://app/thread/missing")).toEqual({ path: rootIndex });
  });

  it("keeps encoded traversal inside the root and safely handles malformed encoding", () => {
    const observedPaths: string[] = [];
    const resolveRequest = createDesktopStaticProtocolResolver(staticRoot, (candidate) => {
      const resolvedCandidate = Path.resolve(candidate);
      observedPaths.push(resolvedCandidate);
      return resolvedCandidate === rootIndex;
    });

    expect(resolveRequest("synara://app/..%2Foutside.js")).toEqual({ error: -6 });
    expect(resolveRequest("synara://app/%E0%A4%A")).toEqual({ path: rootIndex });
    expect(
      observedPaths.every(
        (candidate) => candidate === staticRoot || candidate.startsWith(`${staticRoot}${Path.sep}`),
      ),
    ).toBe(true);
  });
});
