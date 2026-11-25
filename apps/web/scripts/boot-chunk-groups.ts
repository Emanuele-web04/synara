// FILE: boot-chunk-groups.ts
// Purpose: Rolldown chunk groups that load each cold-boot step in a few acyclic chunks.
// Layer: Web build config helper (vite.config.ts)
// Depends on: Vite's Rolldown types and rolldown's group priority semantics.

import path from "node:path";
import { normalizePath, type Rolldown } from "vite";

/** A boot step: the module a cold boot imports at that point, and its chunk name prefix. */
export interface BootChunkStep {
  readonly name: string;
  readonly root: string;
}

export interface BootBandOptions {
  /** Directory that `entry` and the step roots are relative to. */
  readonly root: string;
  /** The entry module. Its static closure is left to the `$initial` groups. */
  readonly entry: string;
  /** Boot steps in load order. A module belongs to the first step whose root reaches it. */
  readonly steps: ReadonlyArray<BootChunkStep>;
  /** Target source bytes per band. */
  readonly bandBytes: number;
}

export interface BootChunkGroupOptions extends BootBandOptions {
  /** Priority of the first band; every later band gets one less. */
  readonly priority: number;
  /** Bands per step; a step that needs more puts the rest in its last band. */
  readonly maxBandsPerStep: number;
}

// A huge module is mostly tree-shaken data (icon sets); counting its whole source would
// give it a near-empty band, and a request, of its own.
const MODULE_BYTES_CAP = 150_000;

type ModuleGraph = Pick<Rolldown.ChunkingContext, "getModuleInfo">;

/**
 * Maps every module of every boot step to a band name (`<step>-<n>`). A step is its
 * root's static import closure minus the entry's and earlier steps' modules. Bands
 * follow a topological order of the step's import graph, dependencies first, with each
 * strongly connected component kept whole, so a band only imports earlier bands and
 * no chunk-import cycle can form.
 */
export function assignBootBands(graph: ModuleGraph, options: BootBandOptions): Map<string, string> {
  const resolve = (file: string) => {
    const absolute = path.resolve(options.root, file);
    for (const id of [normalizePath(absolute), absolute]) {
      if (graph.getModuleInfo(id)) return id;
    }
    throw new Error(`Boot chunk root ${file} is not in the module graph; update its step.`);
  };
  const stepOf = new Map<string, string | null>();
  const starts: ReadonlyArray<readonly [string | null, string]> = [
    [null, options.entry],
    ...options.steps.map((step) => [step.name, step.root] as const),
  ];
  for (const [step, root] of starts) {
    const pending = [resolve(root)];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      const info = stepOf.has(id) ? null : graph.getModuleInfo(id);
      if (!info) continue;
      stepOf.set(id, step);
      pending.push(...info.importedIds);
    }
  }

  const bands = new Map<string, string>();
  for (const { name } of options.steps) {
    const members = new Set([...stepOf].filter(([, step]) => step === name).map(([id]) => id));
    let band = 0;
    let bytes = 0;
    for (const component of componentsDependenciesFirst(graph, members)) {
      const size = component.reduce(
        (sum, id) => sum + Math.min(graph.getModuleInfo(id)?.code?.length ?? 0, MODULE_BYTES_CAP),
        0,
      );
      if (bytes > 0 && bytes + size > options.bandBytes) {
        band += 1;
        bytes = 0;
      }
      bytes += size;
      for (const id of component) bands.set(id, `${name}-${band}`);
    }
  }
  return bands;
}

// Tarjan's algorithm without recursion. Components come out dependencies first.
function componentsDependenciesFirst(graph: ModuleGraph, members: ReadonlySet<string>): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const frames: Array<{ id: string; deps: string[]; next: number }> = [];
  const enter = (id: string) => {
    order.set(id, order.size);
    low.set(id, order.get(id)!);
    stack.push(id);
    onStack.add(id);
    const deps = (graph.getModuleInfo(id)?.importedIds ?? []).filter((dep) => members.has(dep));
    frames.push({ id, deps, next: 0 });
  };
  for (const start of members) {
    if (order.has(start)) continue;
    enter(start);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      if (frame.next < frame.deps.length) {
        const dep = frame.deps[frame.next]!;
        frame.next += 1;
        if (!order.has(dep)) enter(dep);
        else if (onStack.has(dep)) low.set(frame.id, Math.min(low.get(frame.id)!, order.get(dep)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) !== order.get(frame.id)) continue;
      const component: string[] = [];
      let id: string;
      do {
        id = stack.pop()!;
        onStack.delete(id);
        component.push(id);
      } while (id !== frame.id);
      components.push(component);
    }
  }
  return components;
}

/**
 * One group per band, earlier bands first. A group takes its modules' static
 * dependencies with it (includeDependenciesRecursively), so a later band processed
 * before an earlier one would take modules that the earlier band would then import
 * from it. The band map is built on the first call, once per `vite build`.
 */
export function bootChunkGroups(options: BootChunkGroupOptions): Rolldown.CodeSplittingGroup[] {
  let bands: Map<string, string> | undefined;
  const groups: Rolldown.CodeSplittingGroup[] = [];
  for (const [stepIndex, step] of options.steps.entries()) {
    for (let band = 0; band < options.maxBandsPerStep; band += 1) {
      const name = `${step.name}-${band}`;
      const last = band === options.maxBandsPerStep - 1;
      groups.push({
        name: (moduleId, ctx) => {
          bands ??= assignBootBands(ctx, options);
          const assigned = bands.get(moduleId);
          if (assigned === name) return name;
          // Overflow: every later band of this step joins the last one (still acyclic).
          if (last && assigned?.startsWith(`${step.name}-`)) {
            return Number(assigned.slice(step.name.length + 1)) > band ? name : null;
          }
          return null;
        },
        priority: options.priority - stepIndex * options.maxBandsPerStep - band,
      });
    }
  }
  return groups;
}
