import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import type {
  EditorExtensionConsent,
  EditorExtensionSummary,
  EditorExtensionsInput,
  EditorExtensionsResult,
} from "@synara/contracts";
import {
  CODE_OSS_VERSION,
  extensionArchivePath,
  extensionId,
  parseExtensionManifest,
  type ExtensionManifest,
} from "./manifest";
import { OpenVsxRegistry } from "./openVsx";
import { installVsix, MAX_VSIX_BYTES, type InstalledVsix } from "./vsix";

const entrySchema = z.object({
  id: z.string().max(257),
  version: z.string().max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  directory: z.string().max(512),
  enabled: z.boolean(),
  approvedDigest: z.string().optional(),
  source: z.enum(["open-vsx", "vsix"]),
  configuration: z.record(z.string(), z.unknown()),
});
type Entry = z.infer<typeof entrySchema>;
const stateSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema).max(128),
  trustedWorkspaces: z.array(z.string().max(4_096)).max(128),
});
type State = z.infer<typeof stateSchema>;
type Upload = { owner: string; total: number; received: number; chunks: Buffer[]; touched: number };
export interface ExtensionRuntimeControl {
  state(): EditorExtensionsResult["runtime"];
  stopAll(): Promise<void>;
}
const required = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** Channel-local package state. Installation never grants permission to execute. */
export class ExtensionManager {
  readonly home: string;
  readonly packages: string;
  private state: State = { version: 1, entries: [], trustedWorkspaces: [] };
  private loaded: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly uploads = new Map<string, Upload>();
  private readonly shutdown = new AbortController();
  private readonly sweep: ReturnType<typeof setInterval>;
  private disposed = false;
  constructor(
    stateDir: string,
    private readonly registry = new OpenVsxRegistry(),
    private readonly runtime?: ExtensionRuntimeControl,
  ) {
    this.home = path.join(stateDir, "editor-extensions");
    this.packages = path.join(this.home, "packages");
    this.sweep = setInterval(() => {
      for (const [id, upload] of this.uploads) {
        if (Date.now() - upload.touched > 120_000) this.uploads.delete(id);
      }
    }, 30_000).unref();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      if ((await lstat(this.home)).isSymbolicLink())
        throw new Error("Extension state must not be a symlink.");
      const file = path.join(this.home, "state.json");
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size > 16 * 1_024 * 1_024)
          throw new Error("Invalid extension state file.");
        const state = stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
        const ids = new Set<string>();
        for (const entry of state.entries) {
          if (
            entry.id !== extensionId(entry.id) ||
            !semver.valid(entry.version) ||
            ids.has(entry.id)
          ) {
            throw new Error("Invalid or duplicate extension state entry.");
          }
          this.directory(entry);
          ids.add(entry.id);
        }
        if (state.trustedWorkspaces.some((cwd) => !path.isAbsolute(cwd)))
          throw new Error("Invalid workspace trust state.");
        this.state = state;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    })();
    return this.loaded;
  }

  private directory(entry: Pick<Entry, "directory" | "id" | "version" | "digest">): string {
    if (
      extensionArchivePath(entry.directory) !== entry.directory ||
      entry.directory.includes("/") ||
      !entry.directory.startsWith(`${entry.id}-${entry.version}-${entry.digest.slice(0, 16)}-`)
    ) {
      throw new Error("Invalid extension installation directory.");
    }
    return path.join(this.packages, entry.directory);
  }

  async manifest(
    entry: Pick<Entry, "directory" | "id" | "version" | "digest">,
  ): Promise<ExtensionManifest> {
    const directory = this.directory(entry);
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error("Extension installation must not be a symlink.");
    const file = path.join(directory, "package.json");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1_024 * 1_024)
      throw new Error("Invalid installed extension manifest.");
    const manifest = parseExtensionManifest(JSON.parse(await readFile(file, "utf8")));
    if (
      extensionId(`${manifest.publisher}.${manifest.name}`) !== entry.id ||
      manifest.version !== entry.version
    ) {
      throw new Error("Installed extension identity has changed.");
    }
    return manifest;
  }

  private async persist(next: State): Promise<void> {
    const contents = JSON.stringify(next);
    if (contents.length > 16 * 1_024 * 1_024)
      throw new Error("Extension state exceeds the size limit.");
    const temporary = path.join(this.home, `.state-${randomUUID()}.json`);
    try {
      await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
      await rename(temporary, path.join(this.home, "state.json"));
      this.state = next;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async snapshot(): Promise<EditorExtensionsResult> {
    const extensions: EditorExtensionSummary[] = [];
    for (const entry of this.state.entries) {
      const common = {
        id: entry.id,
        version: entry.version,
        digest: entry.digest,
        enabled: entry.enabled,
        approved: entry.approvedDigest === entry.digest,
        source: entry.source,
      };
      try {
        const manifest = await this.manifest(entry);
        extensions.push({
          ...common,
          displayName: manifest.displayName ?? entry.id,
          description: manifest.description ?? "",
          dependencies: (manifest.extensionDependencies ?? []).map(extensionId),
        });
      } catch (error) {
        extensions.push({
          ...common,
          displayName: entry.id,
          description: "",
          dependencies: [],
          error: error instanceof Error ? error.message : "Invalid installation.",
        });
      }
    }
    return {
      apiVersion: CODE_OSS_VERSION,
      extensions,
      registryResults: [],
      trustedWorkspaces: [...this.state.trustedWorkspaces],
      runtime: this.runtime?.state() ?? "not-built",
    };
  }

  private entry(id: string | undefined): Entry {
    const canonical = extensionId(required(id, "Extension identifier"));
    const entry = this.state.entries.find((candidate) => candidate.id === canonical);
    if (!entry) throw new Error("Extension is not installed.");
    return entry;
  }

  private async removePackage(
    entry: Pick<Entry, "directory" | "id" | "version" | "digest">,
  ): Promise<void> {
    const directory = this.directory(entry);
    const root = await realpath(this.packages);
    const resolved = await realpath(directory);
    if (path.dirname(resolved) !== root || (await lstat(directory)).isSymbolicLink()) {
      throw new Error("Refusing to remove an extension outside managed storage.");
    }
    await rm(directory, { recursive: true, force: true });
  }

  private async install(
    selected: InstalledVsix,
    source: Entry["source"],
    signal: AbortSignal,
  ): Promise<void> {
    const pending = new Map<string, InstalledVsix>([[selected.id, selected]]);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = async (id: string, manifest: ExtensionManifest): Promise<void> => {
      signal.throwIfAborted();
      if (visiting.has(id)) throw new Error("Extension dependencies contain a cycle.");
      if (visited.has(id)) return;
      visiting.add(id);
      if (visiting.size > 16 || visited.size + visiting.size > 64)
        throw new Error("Extension dependency graph exceeds the limit.");
      for (const value of manifest.extensionDependencies ?? []) {
        const dependency = extensionId(value);
        const staged = pending.get(dependency);
        const installed = this.state.entries.find((entry) => entry.id === dependency);
        if (staged) await walk(dependency, staged.manifest);
        else if (installed) await walk(dependency, await this.manifest(installed));
        else {
          const metadata = await this.registry.compatible(dependency, signal);
          const archive = await this.registry.download(metadata, signal);
          const next = await installVsix(
            archive,
            this.packages,
            { id: dependency, version: metadata.version },
            signal,
          );
          pending.set(next.id, next);
          await walk(next.id, next.manifest);
        }
      }
      visiting.delete(id);
      visited.add(id);
    };
    let committed = false;
    try {
      await walk(selected.id, selected.manifest);
      signal.throwIfAborted();
      const replaced = this.state.entries.filter((entry) => pending.has(entry.id));
      const next = this.state.entries.filter((entry) => !pending.has(entry.id));
      for (const installation of pending.values()) {
        const previous = replaced.find((entry) => entry.id === installation.id);
        next.push({
          id: installation.id,
          version: installation.version,
          digest: installation.digest,
          directory: installation.directory,
          enabled: false,
          source: installation.id === selected.id ? source : "open-vsx",
          configuration: previous?.configuration ?? {},
        });
      }
      if (next.length > 128) throw new Error("Extension installation limit reached.");
      await this.runtime?.stopAll();
      await this.persist({ ...this.state, entries: next });
      committed = true;
      for (const old of replaced) await this.removePackage(old);
    } finally {
      if (!committed) for (const entry of pending.values()) await this.removePackage(entry);
    }
  }

  private async closure(entry: Entry): Promise<Entry[]> {
    const result = new Map<string, Entry>();
    const visiting = new Set<string>();
    const walk = async (current: Entry): Promise<void> => {
      if (visiting.has(current.id)) throw new Error("Extension dependencies contain a cycle.");
      if (result.has(current.id)) return;
      if (result.size + visiting.size >= 64)
        throw new Error("Extension dependency graph exceeds the limit.");
      visiting.add(current.id);
      const manifest = await this.manifest(current);
      for (const id of manifest.extensionDependencies ?? []) await walk(this.entry(id));
      visiting.delete(current.id);
      result.set(current.id, current);
    };
    await walk(entry);
    return [...result.values()];
  }

  private async enable(
    entry: Entry,
    enabled: boolean,
    consent: readonly EditorExtensionConsent[],
  ): Promise<void> {
    const closure = enabled ? await this.closure(entry) : [entry];
    if (
      enabled &&
      closure.some(
        (candidate) =>
          !consent.some(
            (approval) => approval.id === candidate.id && approval.digest === candidate.digest,
          ),
      )
    ) {
      throw new Error(
        "Explicit approval of this extension and each dependency version is required.",
      );
    }
    const affected = new Set(closure.map((candidate) => candidate.id));
    if (!enabled) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of this.state.entries) {
          if (affected.has(candidate.id)) continue;
          const manifest = await this.manifest(candidate);
          if ((manifest.extensionDependencies ?? []).some((id) => affected.has(extensionId(id)))) {
            affected.add(candidate.id);
            changed = true;
          }
        }
      }
    }
    await this.runtime?.stopAll();
    await this.persist({
      ...this.state,
      entries: this.state.entries.map((candidate) =>
        affected.has(candidate.id)
          ? { ...candidate, enabled, ...(enabled ? { approvedDigest: candidate.digest } : {}) }
          : candidate,
      ),
    });
  }

  private upload(owner: string, id: string | undefined): Upload {
    const upload = this.uploads.get(required(id, "Upload identifier"));
    if (!upload || upload.owner !== owner)
      throw new Error("Upload is unavailable to this connection.");
    upload.touched = Date.now();
    return upload;
  }

  request(
    owner: string,
    input: EditorExtensionsInput,
    signal?: AbortSignal,
  ): Promise<EditorExtensionsResult> {
    if (this.disposed) return Promise.reject(new Error("Extension manager is shutting down."));
    const combined = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    // Discovery does not own the mutation queue: a slow catalog request cannot
    // prevent an owner from revoking trust, cancelling uploads or removing code.
    if (input.operation === "catalog" || input.operation === "details") {
      return (async () => {
        const readSignal = AbortSignal.any([combined, AbortSignal.timeout(35_000)]);
        readSignal.throwIfAborted();
        await this.load();
        const result =
          input.operation === "catalog"
            ? await this.registry.catalog(input, readSignal)
            : {
                registryDetails: await this.registry.details(
                  extensionId(required(input.id, "Extension identifier")),
                  readSignal,
                ),
              };
        readSignal.throwIfAborted();
        return { ...(await this.snapshot()), ...result };
      })();
    }
    const operation = this.queue.then(async () => {
      combined.throwIfAborted();
      await this.load();
      let extra: Partial<EditorExtensionsResult> = {};
      switch (input.operation) {
        case "list":
          break;
        case "inspect": {
          const entry = this.entry(input.id);
          const manifest = await this.manifest(entry);
          extra = {
            configurationJson: JSON.stringify(entry.configuration, null, 2),
            configurationSchemaJson: JSON.stringify(manifest.contributes?.configuration ?? {}),
          };
          break;
        }
        case "search":
          extra = { registryResults: await this.registry.search(input.query ?? "", combined) };
          break;
        case "install": {
          const id = extensionId(required(input.id, "Extension identifier"));
          const metadata = input.version
            ? await this.registry.metadata(id, input.version, combined)
            : await this.registry.compatible(id, combined);
          const archive = await this.registry.download(metadata, combined);
          await this.install(
            await installVsix(archive, this.packages, { id, version: metadata.version }, combined),
            "open-vsx",
            combined,
          );
          break;
        }
        case "uploadBegin": {
          const total = input.total;
          if (
            !total ||
            total > MAX_VSIX_BYTES ||
            this.uploads.size >= 2 ||
            [...this.uploads.values()].some((upload) => upload.owner === owner)
          ) {
            throw new Error("Invalid VSIX size or an upload is already active.");
          }
          const uploadId = randomUUID();
          this.uploads.set(uploadId, {
            owner,
            total,
            received: 0,
            chunks: [],
            touched: Date.now(),
          });
          extra = { uploadId, offset: 0 };
          break;
        }
        case "uploadAppend": {
          const upload = this.upload(owner, input.uploadId);
          const chunk = required(input.chunk, "VSIX chunk");
          const bytes = Buffer.from(chunk, "base64");
          if (
            chunk.length > 1_048_576 ||
            bytes.toString("base64") !== chunk ||
            input.offset !== upload.received ||
            upload.received + bytes.length > upload.total
          )
            throw new Error("Invalid or out-of-order VSIX chunk.");
          upload.chunks.push(bytes);
          upload.received += bytes.length;
          extra = { uploadId: input.uploadId, offset: upload.received };
          break;
        }
        case "uploadFinish": {
          const upload = this.upload(owner, input.uploadId);
          if (upload.received !== upload.total) throw new Error("The VSIX upload is incomplete.");
          const archive = Buffer.concat(upload.chunks, upload.total);
          this.uploads.delete(input.uploadId!);
          await this.install(
            await installVsix(archive, this.packages, undefined, combined),
            "vsix",
            combined,
          );
          break;
        }
        case "uploadCancel":
          this.upload(owner, input.uploadId);
          this.uploads.delete(input.uploadId!);
          break;
        case "remove": {
          const entry = this.entry(input.id);
          if (!input.version || entry.version !== input.version)
            throw new Error("The installed extension version changed. Review removal again.");
          for (const candidate of this.state.entries) {
            if (candidate.id === entry.id) continue;
            const manifest = await this.manifest(candidate);
            if ((manifest.extensionDependencies ?? []).some((id) => extensionId(id) === entry.id)) {
              throw new Error(`Remove dependent extension ${candidate.id} first.`);
            }
          }
          await this.runtime?.stopAll();
          await this.persist({
            ...this.state,
            entries: this.state.entries.filter((candidate) => candidate.id !== entry.id),
          });
          await this.removePackage(entry);
          break;
        }
        case "setEnabled": {
          if (input.enabled === undefined) throw new Error("Enabled state is required.");
          await this.enable(this.entry(input.id), input.enabled, input.consent ?? []);
          break;
        }
        case "configure": {
          const entry = this.entry(input.id);
          const json = required(input.configurationJson, "Configuration");
          if (json.length > 512_000) throw new Error("Extension configuration is too large.");
          const configuration = z.record(z.string(), z.unknown()).parse(JSON.parse(json));
          if (
            Object.keys(configuration).some((key) =>
              ["__proto__", "constructor", "prototype"].includes(key),
            )
          ) {
            throw new Error("Invalid configuration key.");
          }
          await this.runtime?.stopAll();
          await this.persist({
            ...this.state,
            entries: this.state.entries.map((candidate) =>
              candidate.id === entry.id ? { ...candidate, configuration } : candidate,
            ),
          });
          break;
        }
        case "checkUpdates": {
          const snapshot = await this.snapshot();
          const entries = input.id
            ? [this.entry(input.id)]
            : this.state.entries.filter((entry) => entry.source === "open-vsx");
          const updates = new Map<string, string>();
          for (const entry of entries) {
            const metadata = await this.registry.compatible(entry.id, combined);
            if (semver.gt(metadata.version, entry.version)) updates.set(entry.id, metadata.version);
          }
          extra = {
            extensions: snapshot.extensions.map((entry) =>
              updates.has(entry.id) ? { ...entry, updateVersion: updates.get(entry.id)! } : entry,
            ),
          };
          break;
        }
        case "setTrust": {
          if (input.trusted === undefined) throw new Error("Explicit workspace trust is required.");
          const cwd = await realpath(required(input.cwd, "Workspace directory"));
          if (!(await lstat(cwd)).isDirectory() || cwd === path.parse(cwd).root)
            throw new Error("Choose a workspace directory, not a filesystem root.");
          await this.runtime?.stopAll();
          const trusted = this.state.trustedWorkspaces.filter((value) => value !== cwd);
          if (input.trusted) trusted.push(cwd);
          if (trusted.length > 128) throw new Error("Workspace trust limit reached.");
          await this.persist({ ...this.state, trustedWorkspaces: trusted });
          break;
        }
      }
      return { ...(await this.snapshot()), ...extra };
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async executableExtensions(
    cwd: string,
  ): Promise<{ entry: Entry; manifest: ExtensionManifest; directory: string }[]> {
    await this.load();
    const workspace = await realpath(cwd);
    if (!this.state.trustedWorkspaces.includes(workspace))
      throw new Error("This workspace is not trusted for extension execution.");
    const result: { entry: Entry; manifest: ExtensionManifest; directory: string }[] = [];
    for (const entry of this.state.entries.filter(
      (candidate) => candidate.enabled && candidate.approvedDigest === candidate.digest,
    )) {
      const closure = await this.closure(entry);
      if (
        closure.some(
          (dependency) => !dependency.enabled || dependency.approvedDigest !== dependency.digest,
        )
      ) {
        throw new Error(`Extension ${entry.id} has a disabled or unapproved dependency.`);
      }
      result.push({
        entry,
        manifest: await this.manifest(entry),
        directory: this.directory(entry),
      });
    }
    return result;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.shutdown.abort(new Error("Extension manager is shutting down."));
    clearInterval(this.sweep);
    this.uploads.clear();
    await this.queue;
    await this.runtime?.stopAll();
  }
}
