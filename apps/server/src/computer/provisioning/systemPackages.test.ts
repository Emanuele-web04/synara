import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  awaitingAuthorization,
  commandOnPath,
  createPkexecRunner,
  installSystemPackages,
  installClipboardSystemPackage,
  planSystemPackageInstall,
  type PrivilegedRunner,
  type SystemPackagePlan,
} from "./systemPackages.ts";

function exitError(code: number | string, stderr = ""): Error & { code: unknown; stderr: string } {
  return Object.assign(new Error(`Command failed`), { code, stderr });
}

const EVERY_MANAGER = () => true;

describe("planSystemPackageInstall", () => {
  it("packages for the distribution's own manager, not the first one on PATH", () => {
    // The failure this replaces: a Debian container's dnf, or a pacman
    // installed on Ubuntu to build an AUR package, decided which manager ran
    // as root. That is not a failed install — it is a package database being
    // written by a manager that does not own it.
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "debian" })?.manager).toBe("apt-get");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "fedora" })?.manager).toBe("dnf");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "arch" })?.manager).toBe("pacman");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "opensuse-tumbleweed" })?.manager).toBe(
      "zypper",
    );
  });

  it("knows the derivatives by name rather than guessing from a family", () => {
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "linuxmint" })?.manager).toBe("apt-get");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "Manjaro" })?.manager).toBe("pacman");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "rocky" })?.manager).toBe("dnf");
  });

  it("falls back to PATH order for a distribution nobody here has heard of", () => {
    expect(
      planSystemPackageInstall((command) => command === "dnf", { id: "gentoo" })?.manager,
    ).toBe("dnf");
    expect(planSystemPackageInstall(EVERY_MANAGER, { id: "unknown" })?.manager).toBe("pacman");
  });

  it("falls back to PATH when a derivative swapped the manager out from under it", () => {
    // Named as apt-get, but this machine has no apt-get: an identity that
    // cannot run is worse than no identity at all.
    expect(
      planSystemPackageInstall((command) => command === "dnf", { id: "ubuntu" })?.manager,
    ).toBe("dnf");
  });

  it("names the packages for the manager it picked", () => {
    const plan = planSystemPackageInstall(EVERY_MANAGER, { id: "fedora" });
    expect(plan?.packages).toContain("kwin-wayland");
    expect(plan?.packages).toContain("kwin-devel");
  });

  it("answers undefined when no manager it knows is installed at all", () => {
    expect(planSystemPackageInstall(() => false, { id: "arch" })).toBeUndefined();
    expect(planSystemPackageInstall(() => false)).toBeUndefined();
  });

  it("names the compositor and the build toolchain in every plan", () => {
    for (const manager of ["pacman", "apt-get", "dnf", "zypper"]) {
      const plan = planSystemPackageInstall((command) => command === manager);
      expect(plan, manager).toBeDefined();
      expect(plan!.packages.join(" "), manager).toMatch(/kwin/);
      expect(plan!.packages, manager).toContain("cmake");
      expect(plan!.packages, manager).toContain("wl-clipboard");
      expect(plan!.packages, manager).toContain("extra-cmake-modules");
      expect(plan!.packages, manager).toContain("make");
      // The build script configures CMake with `-G Ninja` and refuses to start
      // without it; the package is named differently across distributions.
      expect(
        plan!.packages.filter((name) => /^ninja(-build)?$/.test(name)),
        manager,
      ).toHaveLength(1);
    }
  });
});

describe("installSystemPackages", () => {
  const plan: SystemPackagePlan = {
    manager: "pacman",
    args: ["-S", "--needed", "--noconfirm"],
    packages: ["kwin", "cmake"],
  };

  it("runs the manager non-interactively with the whole package set", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run: PrivilegedRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };
    const summary = await installSystemPackages(plan, run);
    expect(calls).toEqual([
      { command: "pacman", args: ["-S", "--needed", "--noconfirm", "kwin", "cmake"] },
    ]);
    expect(summary).toBe("Installed kwin, cmake with pacman.");
  });

  it("keeps apt from stopping on a debconf question", async () => {
    const aptPlan: SystemPackagePlan = {
      manager: "apt-get",
      args: ["install", "-y"],
      packages: ["kwin-wayland"],
    };
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await installSystemPackages(aptPlan, async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    });
    expect(calls[0]?.command).toBe("env");
    expect(calls[0]?.args).toEqual([
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "install",
      "-y",
      "kwin-wayland",
    ]);
  });

  it("translates a dismissed authorization dialog into a retryable refusal", async () => {
    const failure = installSystemPackages(plan, async () => {
      throw exitError(126);
    });
    await expect(failure).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("authorization dialog was dismissed"),
    });
  });

  it("explains a missing polkit agent and offers the manual command", async () => {
    const failure = installSystemPackages(plan, async () => {
      throw exitError(127);
    });
    await expect(failure).rejects.toThrow(
      /authorization failed.*sudo pacman -S --needed --noconfirm kwin cmake/s,
    );
  });

  it("explains missing pkexec and offers the manual command", async () => {
    const failure = installSystemPackages(plan, async () => {
      throw exitError("ENOENT");
    });
    await expect(failure).rejects.toThrow(/pkexec is not installed.*sudo pacman/s);
  });

  it("surfaces the package manager's own last words on other failures", async () => {
    const failure = installSystemPackages(plan, async () => {
      throw exitError(1, "resolving dependencies...\nerror: target not found: kwin\n");
    });
    await expect(failure).rejects.toThrow(
      "pacman failed to install packages: error: target not found: kwin",
    );
  });
});

describe("commandOnPath", () => {
  it("resolves through PATH entries the way the shell would", () => {
    const seen: string[] = [];
    const found = commandOnPath("kwin_wayland", { PATH: "/usr/local/bin:/usr/bin" }, (path) => {
      seen.push(path);
      return path === "/usr/bin/kwin_wayland";
    });
    expect(found).toBe(true);
    expect(seen).toEqual(["/usr/local/bin/kwin_wayland", "/usr/bin/kwin_wayland"]);
  });

  it("answers no with no PATH at all", () => {
    expect(commandOnPath("kwin_wayland", {}, () => true)).toBe(false);
  });
});

describe("installClipboardSystemPackage", () => {
  it("installs only clipboard utilities on an existing host desktop", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await installClipboardSystemPackage(
      () => planSystemPackageInstall((command) => command === "apt-get"),
      async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    );
    expect(calls).toEqual([
      {
        command: "env",
        args: ["DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "wl-clipboard"],
      },
    ]);
  });

  it("offers manual setup when no package manager is recognized", async () => {
    await expect(
      installClipboardSystemPackage(
        () => undefined,
        async () => {
          throw new Error("must not install");
        },
      ),
    ).rejects.toThrow("Install wl-clipboard with your distribution's package manager");
  });
});

/** A pkexec that records signals and ends only when told to. */
class FakePkexec extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4_242_424;
  exitCode: number | null = null;

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }
}

function pkexecHarness(options: { readonly timeoutMs?: number } = {}) {
  const child = new FakePkexec();
  const state = { awaiting: true, signals: [] as string[], argv: [] as string[] };
  const run = createPkexecRunner({
    spawnPkexec: (args) => {
      state.argv = [...args];
      return child as unknown as ChildProcess;
    },
    awaitingAuthorization: () => state.awaiting,
    signalProcess: (_pid, signal) => {
      if (!state.awaiting) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      state.signals.push(signal);
      queueMicrotask(() => child.finish(null, signal));
    },
    authorizationTimeoutMs: options.timeoutMs ?? 60_000,
  });
  return { child, state, run };
}

describe("the pkexec runner", () => {
  const plan: SystemPackagePlan = { manager: "pacman", args: ["-S"], packages: ["kwin"] };

  it("gives up on a dialog nobody answers, which installs nothing", async () => {
    vi.useFakeTimers();
    try {
      const { state, run } = pkexecHarness({ timeoutMs: 300_000 });
      const install = installSystemPackages(plan, run);
      const outcome = install.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(state.signals).toEqual(["SIGTERM"]);
      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining(
          "Nobody answered the system authorization dialog within 5 minutes",
        ),
        retryable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never interrupts a package manager that is already running as root", async () => {
    vi.useFakeTimers();
    try {
      const { child, state, run } = pkexecHarness({ timeoutMs: 1_000 });
      const controller = new AbortController();
      const install = run("pacman", ["-S", "kwin"], { signal: controller.signal });
      // Authorized: pkexec has become the manager.
      state.awaiting = false;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      controller.abort();
      expect(state.signals).toEqual([]);

      // A slow mirror is allowed to be slow; the run ends when the manager does.
      child.finish(0);
      await expect(install).resolves.toEqual({ stdout: "", stderr: "" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a run that is still waiting for authorization", async () => {
    const { state, run } = pkexecHarness();
    const controller = new AbortController();
    const install = installSystemPackages(plan, run, { signal: controller.signal });
    controller.abort();
    await expect(install).rejects.toThrow(/cancelled before it was authorized/);
    expect(state.signals).toEqual(["SIGTERM"]);
    expect(state.argv).toEqual(["pacman", "-S", "kwin"]);
  });

  it("does not start a run that was cancelled before it began", async () => {
    const { state, run } = pkexecHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(run("pacman", ["-S"], { signal: controller.signal })).rejects.toThrow(
      /cancelled before it was authorized/,
    );
    expect(state.argv).toEqual([]);
  });

  it("never takes an ordinary process for pkexec awaiting a dialog", () => {
    expect(awaitingAuthorization(process.pid)).toBe(false);
    expect(awaitingAuthorization(2 ** 30)).toBe(false);
  });

  it("still reports the manager's own exit codes", async () => {
    const { child, run } = pkexecHarness();
    const install = installSystemPackages(plan, run);
    child.finish(126);
    await expect(install).rejects.toThrow(/authorization dialog was dismissed/);
  });
});
