import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionInstanceId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { RuntimeInstanceUnknownError, RuntimeProviderUnsupportedError } from "../Errors.ts";
import {
  RuntimeProviderRegistry,
  type RuntimeProviderRegistryShape,
} from "../Services/RuntimeProviderRegistry.ts";
import type { ExecutionRuntimeExecCollectResult } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import { RuntimeWorkspaceDiff } from "../Services/RuntimeWorkspaceDiff.ts";
import { RuntimeWorkspaceDiffLive } from "./RuntimeWorkspaceDiff.ts";

const INSTANCE_ID = ExecutionInstanceId.makeUnsafe("inst-diff-1");
const WORKDIR = "/root/synara";

type GitCall = { readonly args: ReadonlyArray<string>; readonly cwd: string | undefined };

const SANDBOX_DIFF = [
  "diff --git a/sandbox.txt b/sandbox.txt",
  "new file mode 100644",
  "index 0000000..a1b2c3d",
  "--- /dev/null",
  "+++ b/sandbox.txt",
  "@@ -0,0 +1,1 @@",
  "+from the sandbox",
  "",
].join("\n");

// A registry whose adapter records every routed git call and answers each git
// subcommand from a canned table, so the seam's command sequence and parsing are
// asserted without a real git binary.
function makeRegistry(options: {
  readonly adapterResolves: boolean;
  readonly respond?: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ExecutionRuntimeExecCollectResult, RuntimeInstanceUnknownError>;
  readonly calls: GitCall[];
}): RuntimeProviderRegistryShape {
  const die = <A>() => Effect.die(new Error("unexpected registry call")) as Effect.Effect<A, never>;
  const adapter = {
    provision: () => die(),
    createTransport: () => die(),
    execCollect: (
      _instanceId: ExecutionInstanceId,
      input: {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly cwd?: string;
      },
    ) => {
      options.calls.push({ args: input.args, cwd: input.cwd });
      return options.respond?.(input.args) ?? Effect.succeed({ stdout: "", stderr: "", code: 0 });
    },
    isAlive: () => Effect.succeed(true),
    destroy: () => Effect.void,
  };
  return {
    getDescriptor: () => die(),
    getDescriptorByFlavor: () => die(),
    listProviders: () => Effect.succeed([]),
    getAdapter: () =>
      options.adapterResolves
        ? Effect.succeed(adapter as never)
        : Effect.fail(new RuntimeProviderUnsupportedError({ provider: "daytona" })),
  };
}

const readDiff = (registry: RuntimeProviderRegistryShape) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* RuntimeWorkspaceDiff;
      return yield* service.read({
        instanceId: INSTANCE_ID,
        provider: "daytona",
        workdir: WORKDIR,
      });
    }).pipe(
      Effect.provide(
        RuntimeWorkspaceDiffLive.pipe(
          Layer.provide(Layer.succeed(RuntimeProviderRegistry, registry)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

describe("RuntimeWorkspaceDiffLive", () => {
  it("routes intent-to-add, binary diff, and porcelain status through the adapter", async () => {
    const calls: GitCall[] = [];
    const registry = makeRegistry({
      adapterResolves: true,
      calls,
      respond: (args) => {
        if (args[0] === "diff") {
          return Effect.succeed({ stdout: SANDBOX_DIFF, stderr: "", code: 0 });
        }
        if (args[0] === "status") {
          return Effect.succeed({ stdout: "A  sandbox.txt\0", stderr: "", code: 0 });
        }
        return Effect.succeed({ stdout: "", stderr: "", code: 0 });
      },
    });

    const result = await readDiff(registry);

    expect(calls.map((call) => call.args)).toEqual([
      ["add", "-A", "-N"],
      ["diff", "--binary", "HEAD"],
      ["status", "--porcelain=v1", "-z"],
    ]);
    expect(calls.every((call) => call.cwd === WORKDIR)).toBe(true);
    expect(result.diff).toBe(SANDBOX_DIFF);
    expect(result.changedPaths).toEqual(["sandbox.txt"]);
    // A successful read of real changes is not degraded — distinct from the
    // empty fallback paths below.
    expect(result.degraded).toBe(false);
  });

  it("degrades to a flagged empty diff when no adapter resolves", async () => {
    const calls: GitCall[] = [];
    const registry = makeRegistry({ adapterResolves: false, calls });

    const result = await readDiff(registry);

    expect(result).toEqual({ diff: "", changedPaths: [], degraded: true });
    expect(calls).toHaveLength(0);
  });

  it("degrades to a flagged empty diff when a git exec fails", async () => {
    const calls: GitCall[] = [];
    const registry = makeRegistry({
      adapterResolves: true,
      calls,
      respond: () =>
        Effect.fail(new RuntimeInstanceUnknownError({ instanceId: String(INSTANCE_ID) })),
    });

    const result = await readDiff(registry);

    // The seam never throws on a failed exec; it reports a degraded empty diff so
    // the caller can tell an unreadable sandbox from a genuinely clean tree.
    expect(result).toEqual({ diff: "", changedPaths: [], degraded: true });
  });

  it("reports a clean tree as not degraded when git succeeds with no changes", async () => {
    const calls: GitCall[] = [];
    const registry = makeRegistry({ adapterResolves: true, calls });

    const result = await readDiff(registry);

    expect(result).toEqual({ diff: "", changedPaths: [], degraded: false });
  });
});
