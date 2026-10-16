import { describe, expect, it, vi } from "vitest";
import { OpenVsxRegistry, boundedResponse, type RegistryMetadata } from "./openVsx";

const metadata: RegistryMetadata = {
  namespace: "esbenp",
  name: "prettier-vscode",
  version: "12.4.0",
  engines: { vscode: "^1.80.0" },
  files: {
    download:
      "https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/esbenp.prettier-vscode-12.4.0.vsix",
  },
};

describe("Open VSX transport boundaries", () => {
  it("follows the registry's exact production CDN without broadening trust to arbitrary hosts", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/extension.vsix",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("real response bytes"));
    expect((await new OpenVsxRegistry(request).download(metadata)).toString()).toBe(
      "real response bytes",
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]![0])).toBe(
      "https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/extension.vsix",
    );
  });
  it.each([
    "https://openvsx.eclipsecontent.org.attacker.invalid/archive.vsix",
    "https://attacker.invalid/archive.vsix",
    "http://openvsx.eclipsecontent.org/archive.vsix",
    "https://user:password@openvsx.eclipsecontent.org/archive.vsix",
    "https://openvsx.eclipsecontent.org:8443/archive.vsix",
    "http://127.0.0.1/metadata",
  ])("rejects untrusted redirect %s before issuing the next request", async (location) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(new OpenVsxRegistry(request).download(metadata)).rejects.toThrow("Untrusted");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("refuses a registry-supplied download for another extension", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      new OpenVsxRegistry(request).download({
        ...metadata,
        files: { download: "https://open-vsx.org/api/other/package/12.4.0/file/a.vsix" },
      }),
    ).rejects.toThrow("unexpected VSIX download location");
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds actual bytes even without Content-Length", async () => {
    await expect(boundedResponse(new Response("12345"), 4)).rejects.toThrow("size limit");
  });
  it("selects a compatible stable version rather than an offered prerelease", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...metadata,
          version: "13.0.0-beta.1",
          allVersions: { "13.0.0-beta.1": "ignored", "12.4.0": "ignored" },
        }),
      )
      .mockResolvedValueOnce(Response.json(metadata));
    expect((await new OpenVsxRegistry(request).compatible("esbenp.prettier-vscode")).version).toBe(
      "12.4.0",
    );
    expect(String(request.mock.calls[1]![0])).toBe(
      "https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0",
    );
  });
});
