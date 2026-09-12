import type * as ChildProcess from "node:child_process";

/** Wait for the owned helper before allowing another request or removing its files. */
export async function stopNativeHelper(
  child: ChildProcess.ChildProcess,
  hasExited: () => boolean,
): Promise<void> {
  if (hasExited()) return;
  await new Promise<void>((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      resolve();
    };
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      if (hasExited()) return done();
      forceTimer = setTimeout(() => {
        child.removeListener("exit", done);
        child.removeListener("close", done);
        reject(
          new Error(
            "Native capture helper has not stopped; another capture is blocked until it exits.",
          ),
        );
      }, 1_000);
    }, 1_000);
    child.once("exit", done);
    child.once("close", done);
    child.kill("SIGTERM");
    if (hasExited()) done();
  });
}
