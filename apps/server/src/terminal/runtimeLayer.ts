import { Effect, FileSystem, Layer, Path } from "effect";

import { TerminalManagerLive } from "./Layers/Manager";
import { PtyAdapter } from "./Services/PTY";

type RuntimePtyAdapterLoader = {
  layer: Layer.Layer<PtyAdapter, never, FileSystem.FileSystem | Path.Path>;
};

const runtimePtyAdapterLoaders = {
  bun: () => import("./Layers/BunPTY"),
  node: () => import("./Layers/NodePTY"),
} satisfies Record<string, () => Promise<RuntimePtyAdapterLoader>>;

const makeRuntimePtyAdapterLayer = () =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = runtimePtyAdapterLoaders[runtime];
    const ptyAdapterModule = yield* Effect.promise<RuntimePtyAdapterLoader>(loader);
    return ptyAdapterModule.layer;
  }).pipe(Layer.unwrap);

export const TerminalLayerLive = TerminalManagerLive.pipe(
  Layer.provide(makeRuntimePtyAdapterLayer()),
);
