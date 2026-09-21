export function createExclusiveApplyQueue<T>(
  apply: (value: T) => void | Promise<void>,
): (value: T) => Promise<void> {
  let current: { value: T; promise: Promise<void> } | null = null;

  return (value: T): Promise<void> => {
    if (current && Object.is(current.value, value)) return current.promise;

    const previous = current?.promise ?? Promise.resolve();
    const run = previous.then(
      () => apply(value),
      () => apply(value),
    );
    const wrapped = run.finally(() => {
      if (current?.promise === wrapped) current = null;
    });
    current = { value, promise: wrapped };
    return wrapped;
  };
}
