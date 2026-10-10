import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { installShutdownSignalHandlers } from "./shutdownSignals";

describe("installShutdownSignalHandlers", () => {
  it("registers SIGINT and SIGTERM only once the app is ready", async () => {
    let ready!: () => void;
    const target = { on: vi.fn() };
    const onSignal = vi.fn();
    installShutdownSignalHandlers(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
      onSignal,
      target,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.on).not.toHaveBeenCalled();

    ready();
    await vi.waitFor(() => expect(target.on).toHaveBeenCalledTimes(2));
    expect(target.on.mock.calls.map(([name]) => name)).toEqual(["SIGINT", "SIGTERM"]);
    for (const [name, listener] of target.on.mock.calls as Array<[string, () => void]>) {
      listener();
      expect(onSignal).toHaveBeenLastCalledWith(name);
    }
    expect(onSignal).toHaveBeenCalledTimes(2);
  });

  it("is the only place main.ts registers shutdown signals", () => {
    // Electron replaces a handler registered at module load, and Node does not
    // reinstall one that is registered twice, so main.ts must leave signal
    // registration to installShutdownSignalHandlers.
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    // Any listener whose event is not a plain non-signal string literal, so a
    // looped or variable registration is caught too.
    const direct = main
      .split("\n")
      .filter((line) =>
        /process\.(?:on|once|addListener|prependListener)\(\s*(?!["'](?!SIG))/u.test(line),
      );
    expect(direct).toEqual([]);
    expect(main).toContain("installShutdownSignalHandlers(app.whenReady()");
  });
});
