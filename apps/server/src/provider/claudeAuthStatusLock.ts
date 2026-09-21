// `claude auth status` can redeem a single-use rotating refresh token — a concurrent invocation observes loggedIn:false from the rotation; this FIFO mutex removes the race; plain promises so the Node keepalive and Effect health check share it

let tail: Promise<unknown> = Promise.resolve();

export function acquireClaudeAuthStatusLock(): Promise<() => void> {
  const previousTail = tail;

  let resolveHeld: () => void;
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });

  // Advance the shared tail immediately so any acquirer registered after this call waits for both everyone ahead of it AND this holder's eventual release.
  tail = previousTail.then(() => held);

  return previousTail.then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveHeld();
    };
  });
}
