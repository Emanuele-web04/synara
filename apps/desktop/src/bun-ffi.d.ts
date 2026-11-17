// Minimal bun:ffi surface for the standalone sidecar files
// (carbonHotKey.ts and friends), which run under `bun` but are typechecked
// with this package's node+electron ambient types. Pulling in the full
// @types/bun declaration set is not viable: its `fetch` global requires a
// `preconnect` property that every `typeof fetch` test mock in this package
// would then have to implement. Keep this list to what the sidecars use;
// when a file needs more of bun:ffi, extend it rather than widening types.

declare module "bun:ffi" {
  type FFITypeTag = number & { readonly __ffiTypeTag: unique symbol };

  interface FFIFunctionDescriptor {
    readonly args?: readonly FFITypeTag[];
    readonly returns?: FFITypeTag;
    readonly threadsafe?: boolean;
  }

  export const FFIType: {
    readonly u8: FFITypeTag;
    readonly i8: FFITypeTag;
    readonly u16: FFITypeTag;
    readonly i16: FFITypeTag;
    readonly u32: FFITypeTag;
    readonly i32: FFITypeTag;
    readonly u64: FFITypeTag;
    readonly i64: FFITypeTag;
    readonly usize: FFITypeTag;
    readonly f32: FFITypeTag;
    readonly f64: FFITypeTag;
    readonly ptr: FFITypeTag;
    readonly bool: FFITypeTag;
    readonly char: FFITypeTag;
    readonly cstring: FFITypeTag;
    readonly void: FFITypeTag;
    readonly function: FFITypeTag;
  };

  type FFISymbolMap<S extends Record<string, FFIFunctionDescriptor>> = {
    readonly [K in keyof S]: (...args: any[]) => any;
  };

  interface FFILibrary<S extends Record<string, FFIFunctionDescriptor>> {
    readonly symbols: FFISymbolMap<S>;
    close(): void;
  }

  export function dlopen<S extends Record<string, FFIFunctionDescriptor>>(
    path: string,
    symbols: S,
  ): FFILibrary<S>;

  export function ptr(value: ArrayBuffer | ArrayBufferView): number;

  export class JSCallback {
    constructor(
      callback: (...args: readonly unknown[]) => unknown,
      descriptor: FFIFunctionDescriptor,
    );
    readonly ptr: number;
    close(): void;
  }
}
