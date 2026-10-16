/**
 * The simctl invocations behind the E2E-oriented backend operations: launch
 * options, environment configuration, and keyboard-layout detection. A stubbed
 * process runner records each command so the exact arguments are asserted
 * without an Xcode.
 */
import { describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";

const DEVICE = "AAAA-1111";

const result = (stdout: string, code = 0): ProcessRunResult => ({
  stdout,
  stderr: code === 0 ? "" : "failed",
  code,
  signal: null,
  timedOut: false,
});

function makeBackend(answer: (args: readonly string[]) => ProcessRunResult = () => result("")) {
  const calls: Array<{ readonly args: readonly string[]; readonly env?: NodeJS.ProcessEnv }> = [];
  const backend = new IosSimulatorBackend({
    platform: "darwin",
    processEnv: { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
    run: async (command, args, options) => {
      if (command === "xcrun" && args[0] === "simctl") {
        calls.push({ args: args.slice(1), ...(options?.env ? { env: options.env } : {}) });
        return answer(args.slice(1));
      }
      return result("");
    },
  });
  return { backend, calls };
}

describe("launch", () => {
  it("restarts the app without redirecting its output, and passes environment through SIMCTL_CHILD_", async () => {
    const { backend, calls } = makeBackend(() => result("com.example.shop: 4242"));

    const launched = await backend.launch(DEVICE, "com.example.shop", ["-flag"], {
      terminateExisting: true,
      environment: { UITESTS: "1" },
    });

    expect(launched.pid).toBe(4242);
    const launch = calls.find((call) => call.args[0] === "launch")!;
    expect(launch.args[1]).toBe("--terminate-running-process");
    expect(
      launch.args.some((arg) => arg.startsWith("--stdout=") || arg.startsWith("--stderr=")),
    ).toBe(false);
    expect(launch.args.slice(-3)).toEqual([DEVICE, "com.example.shop", "-flag"]);
    expect(launch.env?.SIMCTL_CHILD_UITESTS).toBe("1");
    // The toolchain pin survives the extra variables.
    expect(launch.env?.DEVELOPER_DIR).toBe("/Applications/Xcode.app/Contents/Developer");
  });
});

describe("configure", () => {
  it("maps each setting onto its simctl command", async () => {
    const { backend, calls } = makeBackend();

    await backend.configure(DEVICE, { kind: "appearance", appearance: "dark" });
    await backend.configure(DEVICE, { kind: "content-size", category: "accessibility-large" });
    await backend.configure(DEVICE, { kind: "location", latitude: 45.46, longitude: 9.19 });
    await backend.configure(DEVICE, { kind: "location-clear" });
    await backend.configure(DEVICE, {
      kind: "privacy",
      action: "grant",
      service: "photos",
      bundleId: "com.example.shop",
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["ui", DEVICE, "appearance", "dark"],
      ["ui", DEVICE, "content_size", "accessibility-large"],
      ["location", DEVICE, "set", "45.46,9.19"],
      ["location", DEVICE, "clear"],
      ["privacy", DEVICE, "grant", "photos", "com.example.shop"],
    ]);
  });

  it("reports simctl's own refusal", async () => {
    const { backend } = makeBackend(() => result("", 1));

    await expect(
      backend.configure(DEVICE, { kind: "appearance", appearance: "dark" }),
    ).rejects.toThrow(/simctl ui failed: failed/);
  });
});

describe("keyboard layout", () => {
  it("is US when the first keyboard is en_US", async () => {
    const { backend } = makeBackend((args) =>
      args.includes("AppleKeyboards")
        ? result('(\n    "en_US@sw=QWERTY;hw=Automatic",\n    "emoji@sw=Emoji"\n)')
        : result(""),
    );

    await expect(backend.usesUsKeyboardLayout(DEVICE)).resolves.toBe(true);
  });

  it("is not US for an Italian keyboard, and falls back to the locale with none set", async () => {
    const italian = makeBackend((args) =>
      args.includes("AppleKeyboards")
        ? result('(\n    "it_IT@sw=QWERTY;hw=Automatic"\n)')
        : result(""),
    );
    await expect(italian.backend.usesUsKeyboardLayout(DEVICE)).resolves.toBe(false);

    const localeOnly = makeBackend((args) =>
      args.includes("AppleKeyboards") ? result("", 1) : result("it_IT\n"),
    );
    await expect(localeOnly.backend.usesUsKeyboardLayout(DEVICE)).resolves.toBe(false);

    const usLocale = makeBackend((args) =>
      args.includes("AppleKeyboards") ? result("", 1) : result("en_US\n"),
    );
    await expect(usLocale.backend.usesUsKeyboardLayout(DEVICE)).resolves.toBe(true);
  });

  it("asks the simulator once per boot", async () => {
    const { backend, calls } = makeBackend(() => result('("en_US@hw=Automatic")'));

    await backend.usesUsKeyboardLayout(DEVICE);
    await backend.usesUsKeyboardLayout(DEVICE);

    expect(calls.filter((call) => call.args.includes("AppleKeyboards"))).toHaveLength(1);
  });
});

describe("a command for a shut-down simulator", () => {
  const shutDown = (): ProcessRunResult => ({
    stdout: "",
    stderr:
      "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Shutdown",
    code: 149,
    signal: null,
    timedOut: false,
  });

  it("says to boot it instead of passing on CoreSimulator's lookup error", async () => {
    const { backend } = makeBackend(shutDown);

    await expect(backend.install(DEVICE, "/tmp/Missing.app")).rejects.toThrow();
    await expect(backend.launch(DEVICE, "com.example.shop")).rejects.toThrow(
      /simulator is not booted\. Boot it with device_boot/,
    );
  });

  it("does not report a shut-down device's app as not installed", async () => {
    const { backend } = makeBackend(shutDown);

    await expect(
      backend.readLogs(DEVICE, {
        bundleId: "com.example.shop",
        sinceSeconds: 60,
        level: "default",
        limit: 10,
      }),
    ).rejects.toThrow(/not booted/);
  });
});
