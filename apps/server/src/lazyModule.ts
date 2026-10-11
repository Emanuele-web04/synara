// FILE: lazyModule.ts
// Purpose: Builds memoized dynamic-import loaders for heavy dependencies.
// Layer: Server infrastructure utility
// Exports: lazyModule

/**
 * Wraps a dynamic `import()` in a memoized loader so a heavy dependency is
 * resolved and evaluated at most once, and only when a code path actually needs
 * it.
 *
 * Startup used to pay the parse/evaluate cost of every vendor SDK before a
 * single session existed. A loader built here keeps that cost off the boot path
 * while behaving exactly like a static import from the first call onwards: the
 * same module namespace object is handed back every time.
 *
 * Failures are memoized too, matching the ES module registry: a module that
 * throws while evaluating is never re-evaluated, so retrying would only replay
 * the same error.
 */
export function lazyModule<M>(load: () => Promise<M>): () => Promise<M> {
  let modulePromise: Promise<M> | undefined;
  return () => (modulePromise ??= load());
}
