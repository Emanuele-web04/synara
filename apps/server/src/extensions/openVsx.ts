import semver from "semver";
import { z } from "zod";
import { CODE_OSS_VERSION, extensionId } from "./manifest";

const REGISTRY = "https://open-vsx.org";
const MAX_VSIX_BYTES = 128 * 1_024 * 1_024;
const allowedDownloadHosts = new Set([
  "open-vsx.org",
  "openvsxorg.blob.core.windows.net",
  "openvsx.eclipsecontent.org",
]);
const summarySchema = z.object({
  namespace: z.string(),
  name: z.string(),
  version: z.string(),
  displayName: z.string().optional(),
  description: z.string().max(16_384).optional(),
  downloadCount: z.number().int().nonnegative().safe().optional(),
  categories: z.array(z.string().max(128)).max(64).optional(),
  license: z.string().max(512).optional(),
});
const metadataSchema = summarySchema.extend({
  engines: z.object({ vscode: z.string() }),
  preRelease: z.boolean().optional(),
  files: z.object({ download: z.string().url() }),
  allVersions: z.record(z.string(), z.string()).optional(),
});
export type RegistryExtension = z.infer<typeof summarySchema>;
export type RegistryMetadata = z.infer<typeof metadataSchema>;

export async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body)
    throw new Error(`Registry request failed (HTTP ${response.status}).`);
  const length = response.headers.get("content-length");
  if (length && Number(length) > limit) {
    await response.body.cancel();
    throw new Error("Registry response exceeds the size limit.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) throw new Error("Registry response exceeds the size limit.");
      chunks.push(result.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class OpenVsxRegistry {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async json(pathname: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(30_000);
    const response = await this.request(`${REGISTRY}${pathname}`, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: "application/json" },
    });
    return JSON.parse((await boundedResponse(response, 4 * 1_024 * 1_024)).toString("utf8"));
  }

  async search(query: string, signal?: AbortSignal): Promise<RegistryExtension[]> {
    if (query.length > 256) throw new Error("Extension search query is too long.");
    // Exact extension IDs should not depend on the registry's search index.
    // Still resolve metadata from the official registry and validate its identity.
    let exactId;
    try {
      exactId = extensionId(query);
    } catch {
      /* A keyword query uses search. */
    }
    if (exactId) {
      const extension = await this.compatible(exactId, signal);
      return [summarySchema.parse(extension)];
    }
    const result = z
      .object({ extensions: z.array(summarySchema).max(100) })
      .parse(await this.json(`/api/-/search?query=${encodeURIComponent(query)}&size=30`, signal));
    return result.extensions.filter((entry) => {
      try {
        extensionId(`${entry.namespace}.${entry.name}`);
        return semver.valid(entry.version) !== null;
      } catch {
        return false;
      }
    });
  }

  /** Paged discovery is read-only and never grants execution approval. */
  async catalog(
    input: {
      query?: string | undefined;
      category?: string | undefined;
      sortBy?: string | undefined;
      offset?: number | undefined;
    },
    signal?: AbortSignal,
  ) {
    const query = input.query?.trim() ?? "";
    const offset = input.offset ?? 0;
    const category = input.category;
    const sortBy = input.sortBy ?? "downloadCount";
    if (
      query.length > 256 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 9_984 ||
      offset % 24 !== 0 ||
      !["relevance", "downloadCount", "timestamp"].includes(sortBy) ||
      (category !== undefined &&
        !["Programming Languages", "Formatters", "Linters", "Debuggers"].includes(category))
    ) {
      throw new Error("Invalid extension catalog filters.");
    }
    let exactId;
    try {
      exactId = extensionId(query);
    } catch {
      /* Keywords use the registry index. */
    }
    if (exactId) {
      const item = summarySchema.parse(await this.compatible(exactId, signal));
      const matches = !category || item.categories?.includes(category);
      return {
        registryResults: offset === 0 && matches ? [item] : [],
        registryTotal: matches ? 1 : 0,
      };
    }
    const params = new URLSearchParams({
      query,
      size: "24",
      offset: String(offset),
      sortBy,
      sortOrder: "desc",
    });
    if (category) params.set("category", category);
    const response = z
      .object({
        extensions: z.array(summarySchema).max(24),
        offset: z.number().int().nonnegative(),
        totalSize: z.number().int().nonnegative().safe(),
      })
      .parse(await this.json("/api/-/search?" + params, signal));
    // RegistryAPI.search leaves resultOffset at zero for its first registry.
    // Keep our bounded request cursor authoritative instead of resetting it.
    // See eclipse-openvsx/openvsx RegistryAPI.java at 72b6c54, search().
    if (response.offset !== 0 && response.offset !== offset)
      throw new Error("The registry returned a different result page. Retry the search.");
    const ids = new Set<string>();
    const registryResults = response.extensions.filter((item) => {
      try {
        const id = extensionId(item.namespace + "." + item.name);
        if (!semver.valid(item.version) || ids.has(id)) return false;
        ids.add(id);
        return true;
      } catch {
        return false;
      }
    });
    const next = offset + 24;
    return {
      registryResults,
      registryTotal: response.totalSize,
      ...(response.extensions.length === 24 && next < response.totalSize && next <= 9_984
        ? { registryNextOffset: next }
        : {}),
    };
  }

  async details(id: string, signal?: AbortSignal) {
    const metadata = await this.compatible(id, signal);
    return { ...summarySchema.parse(metadata), apiRange: metadata.engines.vscode };
  }

  async metadata(id: string, version: string, signal?: AbortSignal): Promise<RegistryMetadata> {
    const [publisher, name] = extensionId(id).split(".");
    if (version !== "latest" && !semver.valid(version))
      throw new Error("Invalid extension version.");
    const result = metadataSchema.parse(
      await this.json(`/api/${publisher}/${name}/${encodeURIComponent(version)}`, signal),
    );
    if (
      extensionId(`${result.namespace}.${result.name}`) !== extensionId(id) ||
      (version !== "latest" && result.version !== version) ||
      !semver.valid(result.version)
    ) {
      throw new Error("Registry extension identity does not match the request.");
    }
    return result;
  }

  async compatible(id: string, signal?: AbortSignal): Promise<RegistryMetadata> {
    const latest = await this.metadata(id, "latest", signal);
    if (
      !latest.preRelease &&
      !semver.prerelease(latest.version) &&
      semver.satisfies(CODE_OSS_VERSION, latest.engines.vscode)
    )
      return latest;
    const versions = Object.keys(latest.allVersions ?? {})
      .filter((version) => semver.valid(version) && !semver.prerelease(version))
      .sort(semver.rcompare)
      .slice(0, 30);
    for (const version of versions) {
      const candidate = await this.metadata(id, version, signal);
      if (!candidate.preRelease && semver.satisfies(CODE_OSS_VERSION, candidate.engines.vscode))
        return candidate;
    }
    throw new Error(
      "No compatible stable extension version was found in the registry search window.",
    );
  }

  async download(metadata: RegistryMetadata, signal?: AbortSignal): Promise<Buffer> {
    let url = new URL(metadata.files.download);
    const id = extensionId(`${metadata.namespace}.${metadata.name}`);
    const [publisher, name] = id.split(".");
    const prefix = `/api/${publisher}/${name}/${metadata.version}/file/`;
    if (url.origin !== REGISTRY || !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
      throw new Error("Registry supplied an unexpected VSIX download location.");
    }
    const timeout = AbortSignal.timeout(90_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (
        url.protocol !== "https:" ||
        url.port ||
        url.username ||
        url.password ||
        !allowedDownloadHosts.has(url.hostname)
      ) {
        throw new Error("Untrusted extension download redirect.");
      }
      const response = await this.request(url, { redirect: "manual", signal: combinedSignal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Extension redirect is missing its location.");
        url = new URL(location, url);
        continue;
      }
      return boundedResponse(response, MAX_VSIX_BYTES);
    }
    throw new Error("Too many extension download redirects.");
  }
}
