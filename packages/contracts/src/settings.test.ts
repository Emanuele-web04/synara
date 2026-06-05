import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings";

describe("ServerSettings sandbox config", () => {
  it("decodes empty input with fully-defaulted, empty sandbox config", () => {
    const decoded = Schema.decodeSync(ServerSettings)({});
    expect(decoded.sandboxes).toEqual({
      defaultRemoteProvider: "",
      postCloneCommand: "",
      runtime: { cpu: "", memoryMb: "", timeoutSeconds: "", ports: "", persistent: "" },
      daytona: { apiKey: "", apiUrl: "", organizationId: "", target: "", snapshot: "" },
      vercel: { token: "", teamId: "", projectId: "", runtime: "" },
      modal: { tokenId: "", tokenSecret: "", environment: "" },
      cloudflare: { bridgeUrl: "", bridgeToken: "" },
    });
  });

  it("exposes the sandbox defaults on DEFAULT_SERVER_SETTINGS", () => {
    expect(DEFAULT_SERVER_SETTINGS.sandboxes.daytona.apiKey).toBe("");
    expect(DEFAULT_SERVER_SETTINGS.sandboxes.cloudflare.bridgeToken).toBe("");
  });

  it("round-trips a populated sandbox config", () => {
    const decoded = Schema.decodeSync(ServerSettings)({
      sandboxes: {
        defaultRemoteProvider: "daytona",
        daytona: { apiKey: "dtn_key", apiUrl: "https://example.test/api" },
        modal: { tokenId: "id", tokenSecret: "secret" },
      },
    });
    expect(decoded.sandboxes.defaultRemoteProvider).toBe("daytona");
    expect(decoded.sandboxes.daytona.apiKey).toBe("dtn_key");
    expect(decoded.sandboxes.daytona.apiUrl).toBe("https://example.test/api");
    expect(decoded.sandboxes.daytona.target).toBe("");
    expect(decoded.sandboxes.modal.tokenSecret).toBe("secret");
    expect(decoded.sandboxes.vercel.token).toBe("");
  });

  it("decodes the opt-in post-clone command, defaulting it to off", () => {
    expect(Schema.decodeSync(ServerSettings)({}).sandboxes.postCloneCommand).toBe("");
    const decoded = Schema.decodeSync(ServerSettings)({
      sandboxes: { postCloneCommand: "pnpm install --frozen-lockfile" },
    });
    expect(decoded.sandboxes.postCloneCommand).toBe("pnpm install --frozen-lockfile");
    const patch = Schema.decodeSync(ServerSettingsPatch)({
      sandboxes: { postCloneCommand: "auto" },
    });
    expect(patch.sandboxes?.postCloneCommand).toBe("auto");
  });

  it("decodes a sparse sandbox patch with only changed secret fields", () => {
    const patch = Schema.decodeSync(ServerSettingsPatch)({
      sandboxes: {
        vercel: { token: "vrc_token", teamId: "team", projectId: "proj" },
        cloudflare: { bridgeToken: "cf_token" },
      },
    });
    expect(patch.sandboxes?.vercel?.token).toBe("vrc_token");
    expect(patch.sandboxes?.vercel?.runtime).toBeUndefined();
    expect(patch.sandboxes?.cloudflare?.bridgeToken).toBe("cf_token");
    expect(patch.sandboxes?.cloudflare?.bridgeUrl).toBeUndefined();
    expect(patch.sandboxes?.daytona).toBeUndefined();
  });
});
