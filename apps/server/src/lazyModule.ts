/** memoized dynamic import — heavy vendor SDKs used to cost parse/evaluate on the boot path before a single session existed; failures are memoized too, matching the ES module registry */
export function lazyModule<M>(load: () => Promise<M>): () => Promise<M> {
  let modulePromise: Promise<M> | undefined;
  return () => (modulePromise ??= load());
}
