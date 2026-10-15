import { watch } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { URI } from "@code-oss/vs/base/common/uri.js";
import { parse } from "@code-oss/vs/base/common/glob.js";

const MAX_DIRECTORIES = 512;
const MAX_ENTRIES = 20_000;
const MAX_GROUPS = 16;
const within = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
const missing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

/** Read-only, event-driven watching inside the existing OS sandbox. */
export class NativeFileEvents {
  constructor(workspace, deliver, report, watcherExclude = {}) {
    this.workspace = workspace;
    this.deliver = deliver;
    this.report = report;
    this.groups = new Map();
    this.directoryCount = 0;
    this.entryCount = 0;
    this.closed = false;
    this.starting = undefined;
    this.excludes = ["**/.git/**", "**/node_modules/**", ...Object.keys(watcherExclude).filter((key) => watcherExclude[key] === true)];
  }

  start() {
    this.starting ??= this.create("workspace", this.workspace, { recursive: true, excludes: this.excludes });
    return this.starting;
  }

  async watch(session, resource, options = {}) {
    if (typeof session !== "number" || !Number.isFinite(session)) throw new Error("Invalid extension watch session.");
    const uri = URI.revive(resource);
    if (uri.scheme !== "file" || uri.authority) throw new Error("Only workspace file watching is supported.");
    const filename = path.resolve(uri.fsPath);
    if (!within(this.workspace, filename)) throw new Error("Extension watcher leaves its workspace.");
    // Explicit subscriptions are correlated, so global subscribers do not get
    // duplicate events from an extra watch requested by a RelativePattern.
    return this.create(session, filename, options);
  }

  patterns(values) {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 128) throw new Error("Invalid extension watch patterns.");
    return values.map((value) => {
      if (typeof value === "string" && value.length <= 4_096) return parse(value);
      if (value && typeof value.base === "string" && typeof value.pattern === "string" && value.pattern.length <= 4_096 && within(this.workspace, path.resolve(value.base))) return parse(value);
      throw new Error("Invalid extension watch pattern.");
    });
  }

  async create(id, root, options) {
    if (this.closed) throw new Error("Extension file watching has stopped.");
    this.unwatch(id);
    if (this.groups.size >= MAX_GROUPS) throw new Error("Too many extension file watchers.");
    const group = { id, root, recursive: options.recursive === true, excluded: this.patterns(options.excludes), included: this.patterns(options.includes),
      records: new Map(), dirty: new Set(), timer: undefined, running: false, ready: false, closed: false };
    this.groups.set(id, group);
    try {
      if (!within(this.workspace, root) || await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
        throw new Error("An extension watch root must be an existing, non-symlink workspace directory.");
      }
      await this.add(group, root, true);
      group.ready = true;
    } catch (error) {
      this.close(group);
      throw error;
    }
  }

  excluded(group, filename) {
    const normalized = filename.split(path.sep).join("/");
    return group.excluded.some((match) => match(normalized) || match(normalized + "/"));
  }

  async add(group, directory, initial) {
    if (group.closed || group.records.has(directory) || this.excluded(group, directory)) return;
    if (this.directoryCount >= MAX_DIRECTORIES) throw new Error("Extension file watching exceeds the directory limit.");
    if (await realpath(directory) !== directory || (await lstat(directory)).isSymbolicLink()) throw new Error("Extension watcher encountered a symlink directory.");
    if (group.closed) return;
    // Non-recursive watches plus explicit lstat checks avoid following symlink
    // trees and bound kernel watches on all supported Node platforms.
    const watcher = watch(directory, { persistent: false }, () => this.schedule(group, directory));
    const record = { watcher, entries: new Map() };
    group.records.set(directory, record);
    this.directoryCount++;
    watcher.on("error", (error) => this.fail(group, error));
    await this.scan(group, directory, initial);
  }

  schedule(group, directory) {
    if (group.closed) return;
    group.dirty.add(directory);
    if (group.timer || group.running) return;
    group.timer = setTimeout(() => {
      group.timer = undefined;
      group.running = true;
      void (async () => {
        while (!group.closed && group.dirty.size) {
          const directory = group.dirty.values().next().value;
          group.dirty.delete(directory);
          await this.scan(group, directory, !group.ready);
        }
      })().catch((error) => this.fail(group, error)).finally(() => {
        group.running = false;
        if (!group.closed && group.dirty.size) this.schedule(group, group.dirty.values().next().value);
      });
    }, 40).unref();
  }

  async scan(group, directory, initial) {
    const record = group.records.get(directory);
    if (group.closed || !record) return;
    const directoryInfo = await lstat(directory).catch((error) => { if (missing(error)) return undefined; throw error; });
    if (!directoryInfo || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(directory) !== directory) {
      this.removeDirectory(group, directory);
      return;
    }
    const next = new Map();
    const dir = await opendir(directory).catch((error) => { if (missing(error)) return undefined; throw error; });
    if (!dir) { this.removeDirectory(group, directory); return; }
    for await (const entry of dir) {
      if (group.closed) return;
      const filename = path.join(directory, entry.name);
      if (this.excluded(group, filename) || entry.isSymbolicLink()) continue;
      const info = await lstat(filename, { bigint: true }).catch((error) => { if (missing(error)) return undefined; throw error; });
      if (!info || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
      next.set(filename, { directory: info.isDirectory(), stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` });
      if (this.entryCount - record.entries.size + next.size > MAX_ENTRIES) throw new Error("Extension file watching exceeds the entry limit.");
    }
    if (group.closed) return;
    const created = [], changed = [], deleted = [];
    for (const [filename, previous] of record.entries) {
      const current = next.get(filename);
      if (!current || current.directory !== previous.directory) {
        deleted.push(filename);
        if (previous.directory) this.removeDirectory(group, filename);
      }
    }
    for (const [filename, current] of next) {
      const previous = record.entries.get(filename);
      if (!previous || previous.directory !== current.directory) created.push(filename);
      else if (!current.directory && previous.stamp !== current.stamp) changed.push(filename);
    }
    this.entryCount += next.size - record.entries.size;
    record.entries = next;
    if (!initial) this.emit(group, created, changed, deleted);
    if (group.recursive) for (const [filename, item] of next) {
      if (item.directory && !group.records.has(filename)) await this.add(group, filename, initial);
    }
  }

  emit(group, created, changed, deleted) {
    if (group.closed || this.closed) return;
    const convert = (names) => [...new Set(names)].filter((filename) => !group.included.length || group.included.some((match) => match(filename.split(path.sep).join("/")))).map((filename) => URI.file(filename));
    const result = { created: convert(created), changed: convert(changed), deleted: convert(deleted), ...(typeof group.id === "number" ? { session: group.id } : {}) };
    if (result.created.length + result.changed.length + result.deleted.length === 0) return;
    if (result.created.length + result.changed.length + result.deleted.length > 2_000) throw new Error("Extension file-event batch exceeds its limit.");
    void Promise.resolve(this.deliver(result)).catch((error) => this.fail(group, error));
  }

  removeDirectory(group, directory) {
    const deleted = [];
    for (const [name, record] of group.records) {
      if (!within(directory, name)) continue;
      deleted.push(...record.entries.keys());
      record.watcher.close();
      group.records.delete(name);
      this.directoryCount--;
      this.entryCount -= record.entries.size;
    }
    if (group.ready) this.emit(group, [], [], deleted);
  }
  fail(group, error) {
    if (group.closed) return;
    this.close(group);
    this.report(error instanceof Error ? error.message : String(error));
  }
  close(group) {
    if (group.closed) return;
    group.closed = true;
    clearTimeout(group.timer);
    this.removeDirectory(group, group.root);
    group.dirty.clear();
    if (this.groups.get(group.id) === group) this.groups.delete(group.id);
  }
  unwatch(id) { const group = this.groups.get(id); if (group) this.close(group); }
  dispose() {
    this.closed = true;
    for (const group of [...this.groups.values()]) this.close(group);
  }
}
