import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, type ProviderRuntimeEvent } from "@synara/contracts";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
  CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
  codexConfiguredHomePathsFromSettings,
  enabledCodexProviderInstanceIdsFromSettings,
  generatedImagePathFromRuntimeEvent,
  markTrustedCodexGeneratedImageRuntimeEvent,
  resolveCodexGeneratedImagesRoot,
  resolveCodexGeneratedImagesRoots,
} from "./codexGeneratedImages.ts";

function makeImageGenerationCompletedEvent(overrides?: {
  data?: unknown;
  detail?: string;
  raw?: ProviderRuntimeEvent["raw"];
}): ProviderRuntimeEvent {
  return {
    eventId: "evt-1",
    provider: "codex",
    threadId: "thread-1",
    createdAt: new Date(0).toISOString(),
    type: "item.completed",
    payload: {
      itemType: "image_generation",
      status: "completed",
      title: "Generated image",
      ...(overrides?.detail ? { detail: overrides.detail } : {}),
      data:
        overrides?.data ??
        ({
          kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
          origin: CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
          path: "/codex-home/generated_images/thread-1/call-1.png",
          callId: "call-1",
        } as unknown),
    },
    ...(overrides?.raw ? { raw: overrides.raw } : {}),
  } as unknown as ProviderRuntimeEvent;
}

describe("generatedImagePathFromRuntimeEvent", () => {
  it("returns the artifact path for an image_generation completion", () => {
    const event = makeImageGenerationCompletedEvent();
    assert.equal(
      generatedImagePathFromRuntimeEvent(event),
      "/codex-home/generated_images/thread-1/call-1.png",
    );
    assert.strictEqual(markTrustedCodexGeneratedImageRuntimeEvent(event), event);
  });

  it("returns undefined when the artifact has the wrong kind", () => {
    const event = makeImageGenerationCompletedEvent({
      data: { kind: "something-else", path: "/whatever.png" },
    });
    assert.equal(generatedImagePathFromRuntimeEvent(event), undefined);
  });

  it("returns undefined for non-completed event types", () => {
    const startedEvent = {
      ...makeImageGenerationCompletedEvent(),
      type: "item.started",
    } as ProviderRuntimeEvent;
    assert.equal(generatedImagePathFromRuntimeEvent(startedEvent), undefined);
  });

  it("returns undefined when the item type is not image_generation", () => {
    const event = makeImageGenerationCompletedEvent();
    const otherItem = {
      ...event,
      payload: { ...event.payload, itemType: "assistant_message" },
    } as ProviderRuntimeEvent;
    assert.equal(generatedImagePathFromRuntimeEvent(otherItem), undefined);
  });

  it("marks and accepts legacy artifacts when the raw item proves image generation", () => {
    const event = makeImageGenerationCompletedEvent({
      data: {
        kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
        path: "/codex-home/generated_images/thread-1/legacy.png",
      },
      raw: {
        source: "codex.app-server.notification",
        method: "item/completed",
        payload: { item: { type: "image_generation_call" } },
      },
    });

    assert.equal(
      generatedImagePathFromRuntimeEvent(event),
      "/codex-home/generated_images/thread-1/legacy.png",
    );
    const marked = markTrustedCodexGeneratedImageRuntimeEvent(event);
    assert.equal(marked.type, "item.completed");
    if (marked.type === "item.completed") {
      assert.equal(
        (marked.payload.data as { origin?: unknown }).origin,
        CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
      );
    }
  });

  it("rejects legacy artifacts whose raw item is an image view", () => {
    const event = makeImageGenerationCompletedEvent({
      data: {
        kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
        path: "C:\\Users\\Test User\\QA 100%\\page.png",
      },
      raw: {
        source: "codex.app-server.notification",
        method: "item/completed",
        payload: { item: { type: "imageView" } },
      },
    });

    assert.equal(generatedImagePathFromRuntimeEvent(event), undefined);
    assert.strictEqual(markTrustedCodexGeneratedImageRuntimeEvent(event), event);
  });

  it.each(["codex/event/image_generation_end", "image_generation_end"])(
    "accepts an unmarked legacy artifact proved only by method %s",
    (method) => {
      const imagePath = "/codex-home/generated_images/thread-1/legacy-method.png";
      const event = makeImageGenerationCompletedEvent({
        data: { kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND, path: imagePath },
        raw: { source: "codex.app-server.notification", method, payload: {} },
      });

      assert.equal(generatedImagePathFromRuntimeEvent(event), imagePath);
      const marked = markTrustedCodexGeneratedImageRuntimeEvent(event);
      if (marked.type !== "item.completed") assert.fail("Expected a completed item");
      assert.equal(
        (marked.payload.data as { origin?: unknown }).origin,
        CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
      );
      assert.equal((event.payload as { data: { origin?: unknown } }).data.origin, undefined);
    },
  );

  it.each([true, false])(
    "rejects non-Codex artifacts even with legacy proof (marked: %s)",
    (marked) => {
      const event = {
        ...makeImageGenerationCompletedEvent({
          data: {
            kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
            path: "/tmp/other-provider.png",
            ...(marked ? { origin: CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN } : {}),
          },
          raw: {
            source: "codex.app-server.notification",
            method: "image_generation_end",
            payload: {},
          },
        }),
        provider: "claudeAgent",
      } as ProviderRuntimeEvent;

      assert.equal(generatedImagePathFromRuntimeEvent(event), undefined);
      assert.strictEqual(markTrustedCodexGeneratedImageRuntimeEvent(event), event);
    },
  );

  it("rejects unmarked artifacts without explicit legacy evidence", () => {
    const event = makeImageGenerationCompletedEvent({
      data: {
        kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
        path: "/tmp/untrusted.png",
      },
    });

    assert.equal(generatedImagePathFromRuntimeEvent(event), undefined);
  });

  it("rejects an unknown explicit origin instead of replacing it", () => {
    const event = makeImageGenerationCompletedEvent({
      data: {
        kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
        origin: "unknown.producer",
        path: "/tmp/unknown-origin.png",
      },
      raw: {
        source: "codex.app-server.notification",
        method: "image_generation_end",
        payload: {},
      },
    });

    assert.equal(generatedImagePathFromRuntimeEvent(event), undefined);
    assert.strictEqual(markTrustedCodexGeneratedImageRuntimeEvent(event), event);
  });
});

describe("resolveCodexGeneratedImagesRoot(s)", () => {
  const previousSynaraHome = process.env.SYNARA_HOME;

  afterEach(() => {
    if (previousSynaraHome === undefined) delete process.env.SYNARA_HOME;
    else process.env.SYNARA_HOME = previousSynaraHome;
  });

  it("returns the overlay generated_images directory as the active write root by default", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    assert.equal(
      resolveCodexGeneratedImagesRoot("/codex-test/.codex"),
      path.join("/synara-test/runtime", "codex-home-overlay", "generated_images"),
    );
  });

  it("predicts against the account overlay for account-scoped instance context", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    const root = resolveCodexGeneratedImagesRoot({
      homePath: "/codex-test/.codex",
      accountId: "codex_2",
    });
    assert.ok(
      root.startsWith(
        path.join("/synara-test/runtime", "codex-home-overlay", "accounts", "codex_2-"),
      ),
      `expected account overlay root, got ${root}`,
    );
    assert.ok(root.endsWith(path.join("generated_images")));
  });

  it("honors a per-instance SYNARA_HOME when predicting the managed overlay", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    const root = resolveCodexGeneratedImagesRoot({
      homePath: "/codex-test/.codex-work",
      environment: { SYNARA_HOME: "/synara-test/instance-runtime" },
    });
    assert.equal(
      root,
      path.join("/synara-test/instance-runtime", "codex-home-overlay", "generated_images"),
    );
  });

  it("returns both source and overlay generated_images roots for the allowlist", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    assert.deepEqual(resolveCodexGeneratedImagesRoots("/codex-test/.codex"), [
      path.join("/codex-test/.codex", "generated_images"),
      path.join("/synara-test/runtime", "codex-home-overlay", "generated_images"),
    ]);
  });

  it("keeps account overlay roots for the full instance context", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";

    const roots = resolveCodexGeneratedImagesRoots({
      homePath: "/codex-test/.codex-work",
      shadowHomePath: "/codex-test/.codex-work-auth",
      accountId: "codex_work",
    });

    assert.ok(
      roots.some(
        (root) =>
          root.startsWith(
            path.join("/synara-test/runtime", "codex-home-overlay", "accounts", "codex_work-"),
          ) && root.endsWith(path.join("generated_images")),
      ),
      `expected account overlay generated_images root, got ${JSON.stringify(roots)}`,
    );
  });
});

describe("codexConfiguredHomePathsFromSettings", () => {
  const previousSynaraHome = process.env.SYNARA_HOME;

  afterEach(() => {
    if (previousSynaraHome === undefined) delete process.env.SYNARA_HOME;
    else process.env.SYNARA_HOME = previousSynaraHome;
  });

  it("keeps the enabled default Codex home when it has no overrides", () => {
    const candidates = codexConfiguredHomePathsFromSettings(DEFAULT_SERVER_SETTINGS);

    assert.deepEqual(candidates, [{}]);
  });

  it("includes the env-scoped write home for instances relocating the overlay root", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex_env: {
          driver: "codex" as const,
          enabled: true,
          environment: [{ name: "SYNARA_HOME", value: "/instance-env/runtime", sensitive: false }],
        },
      },
    };

    const roots = codexConfiguredHomePathsFromSettings(settings).flatMap((home) =>
      resolveCodexGeneratedImagesRoots(home),
    );

    const expectedPrefix = path.join(
      "/instance-env/runtime",
      "codex-home-overlay",
      "accounts",
      "codex_env-",
    );
    assert.ok(
      roots.some((root) => root.startsWith(expectedPrefix)),
      `expected env-scoped account overlay root, got ${JSON.stringify(roots)}`,
    );
  });

  it("preserves configured account context for generated-image roots", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex_work: {
          driver: "codex" as const,
          enabled: true,
          config: {
            homePath: "/codex-test/.codex-work",
            shadowHomePath: "/codex-test/.codex-work-auth",
            accountId: "codex_work",
          },
        },
      },
    };

    const roots = codexConfiguredHomePathsFromSettings(settings).flatMap((home) =>
      resolveCodexGeneratedImagesRoots(home),
    );
    assert.ok(
      roots.some(
        (root) =>
          root.startsWith(
            path.join("/synara-test/runtime", "codex-home-overlay", "accounts", "codex_work-"),
          ) && root.endsWith(path.join("generated_images")),
      ),
      `expected configured account overlay generated_images root, got ${JSON.stringify(roots)}`,
    );
  });

  it("excludes disabled Codex instance homes from the generated-image allowlist", () => {
    process.env.SYNARA_HOME = "/synara-disabled/runtime";
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex_disabled: {
          driver: "codex" as const,
          enabled: false,
          config: {
            homePath: "/codex-test/.codex-disabled",
            accountId: "codex_disabled",
          },
        },
        codex_enabled: {
          driver: "codex" as const,
          enabled: true,
          config: {
            homePath: "/codex-test/.codex-enabled",
            accountId: "codex_enabled",
          },
        },
      },
    };

    const roots = codexConfiguredHomePathsFromSettings(settings).flatMap((home) =>
      resolveCodexGeneratedImagesRoots(home),
    );
    const enabledInstanceIds = enabledCodexProviderInstanceIdsFromSettings(settings);

    assert.ok([...enabledInstanceIds].some((instanceId) => instanceId === "codex_enabled"));
    assert.ok([...enabledInstanceIds].every((instanceId) => instanceId !== "codex_disabled"));
    assert.ok(
      roots.some((root) => root.includes(path.join("accounts", "codex_enabled-"))),
      `expected enabled account overlay root, got ${JSON.stringify(roots)}`,
    );
    assert.ok(
      roots.every((root) => !root.includes(path.join("accounts", "codex_disabled-"))),
      `expected disabled account overlay root to be absent, got ${JSON.stringify(roots)}`,
    );
  });

  it("excludes disabled default Codex homes from the generated-image allowlist", () => {
    process.env.SYNARA_HOME = "/synara-disabled-default/runtime";
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          enabled: false,
          homePath: "/codex-test/.codex-disabled-default",
        },
      },
    };

    const roots = codexConfiguredHomePathsFromSettings(settings).flatMap((home) =>
      resolveCodexGeneratedImagesRoots(home),
    );

    assert.ok(
      roots.every((root) => !root.includes(".codex-disabled-default")),
      `expected disabled default home to be absent, got ${JSON.stringify(roots)}`,
    );
  });

  it("excludes generic-disabled default Codex homes from the generated-image allowlist", () => {
    process.env.SYNARA_HOME = "/synara-disabled-generic/runtime";
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          enabled: true,
          homePath: "/codex-test/.codex-disabled-generic",
        },
      },
      providerInstances: {
        codex: {
          driver: "codex" as const,
          enabled: false,
          config: {},
        },
      },
    };

    const roots = codexConfiguredHomePathsFromSettings(settings).flatMap((home) =>
      resolveCodexGeneratedImagesRoots(home),
    );

    assert.ok(
      roots.every((root) => !root.includes(".codex-disabled-generic")),
      `expected generic-disabled default home to be absent, got ${JSON.stringify(roots)}`,
    );
  });
});
