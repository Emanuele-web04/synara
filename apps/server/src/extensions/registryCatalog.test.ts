import { describe, expect, it, vi } from "vitest";
import { OpenVsxRegistry } from "./openVsx";

const summary = { namespace: "example", name: "formatter", version: "1.0.0", displayName: "Example formatter", description: "Actual registry metadata", downloadCount: 123, categories: ["Formatters"] };
const metadata = { ...summary, engines: { vscode: "^1.80.0" }, license: "MIT", files: { download: "https://open-vsx.org/api/example/formatter/1.0.0/file/extension.vsix" } };

describe("native marketplace discovery", () => {
  it("uses bounded server-side category, ordering and page controls", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ offset: 24, totalSize: 73,
      extensions: Array.from({ length: 24 }, (_, index) => ({ ...summary, name: `tool-${index}` })) }));
    const result = await new OpenVsxRegistry(request).catalog({ query: "format & lint", category: "Formatters", sortBy: "timestamp", offset: 24 });
    const url = new URL(String(request.mock.calls[0]![0]));
    expect(url.origin).toBe("https://open-vsx.org");
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: "format & lint", category: "Formatters", sortBy: "timestamp", sortOrder: "desc", offset: "24", size: "24" });
    expect(result.registryResults).toHaveLength(24);
    expect(result.registryNextOffset).toBe(48);
    expect(result.registryTotal).toBe(73);
  });
  it("resolves exact IDs without relying on indexing and reports real compatible details", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(metadata));
    const registry = new OpenVsxRegistry(request);
    expect((await registry.catalog({ query: "Example.Formatter" })).registryResults[0]?.downloadCount).toBe(123);
    expect((await registry.details("example.formatter"))).toMatchObject({ license: "MIT", apiRange: "^1.80.0", version: "1.0.0" });
    expect(String(request.mock.calls[0]![0])).toBe("https://open-vsx.org/api/example/formatter/latest");
    expect((await registry.catalog({ query: "example.formatter", category: "Debuggers" })).registryResults).toEqual([]);
  });
  it.each([{ offset: -24 }, { offset: 1 }, { offset: 10_008 }, { offset: Number.NaN }, { category: "../../private" }, { sortBy: "arbitrary" }, { query: "x".repeat(257) }])("rejects invalid controls before issuing a network request: %j", async (input) => {
    const request = vi.fn<typeof fetch>();
    await expect(new OpenVsxRegistry(request).catalog(input)).rejects.toThrow("Invalid extension catalog");
    expect(request).not.toHaveBeenCalled();
  });
  it("does not trust duplicate identities, invalid identifiers or a different result page", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ offset: 0, totalSize: 4, extensions: [summary, summary, { ...summary, namespace: "../outside" }, { ...summary, version: "invalid" }] }))
      .mockResolvedValueOnce(Response.json({ offset: 24, totalSize: 40, extensions: [summary] }));
    const registry = new OpenVsxRegistry(request);
    const result = await registry.catalog({});
    expect(result.registryResults).toEqual([summary]);
    expect(result.registryNextOffset).toBeUndefined();
    await expect(registry.catalog({})).rejects.toThrow("different result page");
  });
  it("passes cancellation to discovery and preserves registry failure", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => { options?.signal?.throwIfAborted(); return new Response("unavailable", { status: 503 }); });
    const registry = new OpenVsxRegistry(request);
    await expect(registry.catalog({})).rejects.toThrow("503");
    const controller = new AbortController(); controller.abort(new Error("catalog cancelled"));
    await expect(registry.catalog({}, controller.signal)).rejects.toThrow("catalog cancelled");
  });
});
