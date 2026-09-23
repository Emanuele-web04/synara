import { types } from "node:util";

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { CuaComputerBackend } from "../CuaComputerBackend.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import { makeComputerServiceLayer } from "./ComputerService.ts";

/** Builds the service exactly as the server does, then runs `body` against it. */
async function withComputerService(
  backend: FakeComputerBackend,
  body: (service: ComputerServiceShape) => Promise<void>,
): Promise<void> {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* Effect.promise(() => body(service));
      }).pipe(Effect.provide(makeComputerServiceLayer({ backend }))),
    ),
  );
}

/** The backend the layer chose; a private field, read only to name it in assertions. */
function backendOf(service: ComputerServiceShape): unknown {
  return (service.manager as unknown as { readonly backend: unknown }).backend;
}

describe("ComputerServiceLive", () => {
  /**
   * The regression this pins is a backend being established by the act of
   * starting the server. Boot decides availability
   * from the passive probe, and seeding a thread's panel — which the web
   * composer does for every ordinary chat — must not upgrade that to the
   * establishing read either.
   */
  it("boots and seeds a thread without ever asking the backend for the desktop", async () => {
    const backend = new FakeComputerBackend();

    await withComputerService(backend, async (service) => {
      expect(service.supported).toBe(true);
      expect(service.availability).toEqual({
        kind: "available",
        backend: "fake",
      });
      expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);

      const seeded = await service.manager.getThreadState("thread-boot");
      expect(seeded.availability).toEqual({
        kind: "available",
        backend: "fake",
      });
      expect(seeded.windows).toEqual([]);
      expect(backend.calls.map((call) => call.method)).toEqual([
        "probeAvailability",
        "probeAvailability",
      ]);
    });
  });

  /**
   * Supported means the host could ever drive a desktop, not that it can right
   * now. A backend whose boot probe fails — a helper not yet installed, a
   * compositor briefly unreachable — must stay routed through the manager, or
   * the frozen verdict caches "unsupported" in every WS handler and the agent
   * gateway until the server restarts, and the backend's re-probe can never
   * report the desktop coming up.
   */
  it("stays supported when the boot probe merely reports the backend unavailable", async () => {
    const backend = new FakeComputerBackend();
    backend.setAvailability({
      kind: "backend-unavailable",
      message: "The backend is not available yet.",
    });

    await withComputerService(backend, async (service) => {
      expect(service.supported).toBe(true);
      expect(service.availability).toMatchObject({
        kind: "backend-unavailable",
      });
    });
  });

  it("keeps the configured override ahead of both reads", async () => {
    const backend = new FakeComputerBackend();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.supported).toBe(false);
          expect(service.availability).toMatchObject({
            kind: "backend-unavailable",
          });
          // An operator switching the feature off is not a question for the
          // desktop, so neither read runs at all.
          expect(backend.calls).toEqual([]);
        }).pipe(Effect.provide(makeComputerServiceLayer({ backend, supported: false }))),
      ),
    );
  });

  /**
   * On Windows there is no backend to build, and the pre-fix fallback was the
   * fake — which answers "available" and succeeds at every action against a
   * phantom desktop. An agent on Windows must see a refused surface, not a
   * fabricated one, so the platform verdict has to reach the pane's blocked
   * state untouched.
   */
  it("reports an unsupported platform instead of a fake desktop on Windows", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.supported).toBe(false);
          expect(service.availability).toEqual({
            kind: "unsupported-platform",
            platform: "win32",
          });
          const state = yield* Effect.promise(() =>
            service.manager.getThreadState("thread-windows"),
          );
          expect(state.availability).toEqual({
            kind: "unsupported-platform",
            platform: "win32",
          });
        }).pipe(
          Effect.provide(makeComputerServiceLayer({ platform: "win32", selection: { env: {} } })),
        ),
      ),
    );
  });

  /**
   * Off-darwin the gate is endpoint presence, not platform identity: a
   * configured host socket means a real driver host exists to reach, so the
   * surface routes a live backend instead of the unsupported-platform
   * refusal. The probe — not the platform — reports whether it answers.
   */
  it("routes a real backend on Windows when a host endpoint is configured", async () => {
    vi.stubEnv("SYNARA_CUA_HOST_SOCKET", "\\\\.\\pipe\\synara-cua-test");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ComputerService;
            expect(service.supported).toBe(true);
            // The endpoint is unreachable from the test host, so the probe
            // reports the backend unavailable — never unsupported-platform.
            expect(service.availability).not.toMatchObject({
              kind: "unsupported-platform",
            });
          }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "win32" }))),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * The Electron app configures the Cua host socket on every platform, Linux
   * included, so socket presence cannot be what routes a Linux desktop: the
   * Linux tiers decide first, and a host no tier claims would fall through
   * to Cua. Naming it explicitly reaches it on any platform.
   */
  it("keeps the Linux tiers ahead of a configured Cua socket, and Cua reachable by name", async () => {
    vi.stubEnv("SYNARA_CUA_HOST_SOCKET", "/tmp/synara-cua-test.sock");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ComputerService;
            expect(service.supported).toBe(true);
            // A Linux desktop backend, not the observation-only Cua host.
            expect(backendOf(service)).not.toBeInstanceOf(CuaComputerBackend);
            expect(service.manager.guidanceProfile).toEqual({
              dialect: "linux",
              dedicatedSeat: true,
            });
          }).pipe(
            Effect.provide(
              makeComputerServiceLayer({
                platform: "linux",
                selection: {
                  env: { SYNARA_CUA_HOST_SOCKET: "/tmp/synara-cua-test.sock" },
                  busNameHasOwner: async () => false,
                },
              }),
            ),
          ),
        ),
      );
      vi.stubEnv("SYNARA_COMPUTER_BACKEND", "cua");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ComputerService;
            expect(service.supported).toBe(true);
            expect(service.availability).not.toMatchObject({ kind: "unsupported-platform" });
            // Named explicitly: the Cua host, observing a desktop it does not drive.
            expect(backendOf(service)).toBeInstanceOf(CuaComputerBackend);
            expect(service.manager.guidanceProfile).toEqual({
              dialect: "linux",
              dedicatedSeat: false,
            });
          }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "linux" }))),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * The floor on Linux: a host that is neither KWin nor any other plugin-able
   * compositor gets the headless nested desktop, constructed but never booted
   * by the act of starting the server.
   */
  it("gives a Linux host no tier claims the nested desktop, without booting it", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.supported).toBe(true);
          expect(service.availability).not.toMatchObject({ kind: "unsupported-platform" });
          if (service.availability.kind === "available") {
            expect(service.availability.backend).toBe("nested-kwin");
          }
          // Passive: the probe answers from the distribution and the host
          // environment alone, so the same fake, un-engaged manager reports it.
          expect(service.manager.guidanceProfile).toEqual({
            dialect: "linux",
            dedicatedSeat: true,
          });
        }).pipe(
          Effect.provide(
            makeComputerServiceLayer({
              platform: "linux",
              selection: { env: {}, busNameHasOwner: async () => false },
            }),
          ),
        ),
      ),
    );
  });

  /**
   * An override is honored or refused, never bypassed. A typo that fell through
   * to auto-detection would boot a different backend and look like the variable
   * does nothing; the unavailable backend carries the reason and the names that
   * do exist instead.
   */
  it("turns a malformed override into an availability card, not another backend", async () => {
    vi.stubEnv("SYNARA_COMPUTER_BACKEND", "protal");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ComputerService;
            expect(service.supported).toBe(false);
            expect(service.availability).toMatchObject({ kind: "backend-unavailable" });
            expect(
              service.availability.kind === "backend-unavailable"
                ? service.availability.message
                : "",
            ).toContain('SYNARA_COMPUTER_BACKEND="protal"');
          }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "darwin" }))),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("routes a KDE Wayland host to the KWin backend without touching the compositor", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.supported).toBe(true);
          // Construction and the boot probe never connect: a host whose bus
          // says KWin is up but that has no plugin anywhere reports exactly
          // that, and nothing is installed or loaded to find out.
          expect(service.availability).toMatchObject({ kind: "backend-unavailable" });
          expect(service.manager.guidanceProfile).toEqual({
            dialect: "linux",
            dedicatedSeat: true,
          });
        }).pipe(
          Effect.provide(
            makeComputerServiceLayer({
              platform: "linux",
              selection: {
                env: { XDG_SESSION_TYPE: "wayland" },
                busNameHasOwner: async (name) => name === "org.kde.KWin",
              },
            }),
          ),
        ),
      ),
    );
  });

  it("routes a live Hyprland session to the Hyprland backend ahead of a KWin bus owner", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.supported).toBe(true);
          // The passive probe answers from the host it runs on: a live
          // Hyprland desktop reports the Hyprland backend, any other host
          // reports the absent session — never a fake, and never the KWin
          // plugin the stray bus owner would have suggested.
          expect(service.availability).not.toMatchObject({ kind: "unsupported-platform" });
          if (service.availability.kind === "available") {
            expect(service.availability.backend).toBe("hyprland");
          } else if (service.availability.kind === "backend-unavailable") {
            expect(service.availability.message).toContain("Hyprland");
          }
        }).pipe(
          Effect.provide(
            makeComputerServiceLayer({
              platform: "linux",
              selection: {
                env: { XDG_SESSION_TYPE: "wayland" },
                busNameHasOwner: async (name) => name === "org.kde.KWin",
                hyprlandSessionPresent: () => true,
              },
            }),
          ),
        ),
      ),
    );
  });

  it("selects the fake backend only when explicitly requested", async () => {
    vi.stubEnv("SYNARA_COMPUTER_BACKEND", "fake");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ComputerService;
            expect(service.supported).toBe(true);
            expect(service.availability).toEqual({
              kind: "available",
              backend: "fake",
            });
          }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "darwin" }))),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("ComputerServiceLive startup selection", () => {
  /** Runs `body` against a Linux service whose tiers are fakes. */
  async function withLinuxService(
    options: {
      readonly env?: NodeJS.ProcessEnv;
      readonly busNameHasOwner: (name: string) => Promise<boolean>;
      readonly hyprlandSessionPresent: () => boolean;
      readonly backends: Partial<Record<"kwin" | "hyprland" | "nested", () => FakeComputerBackend>>;
    },
    body: (service: ComputerServiceShape) => Promise<void>,
  ): Promise<void> {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          yield* Effect.promise(() => body(service));
        }).pipe(
          Effect.provide(
            makeComputerServiceLayer({
              platform: "linux",
              selectionBudgetMs: 30,
              selection: {
                env: options.env ?? {},
                busNameHasOwner: options.busNameHasOwner,
                hyprlandSessionPresent: options.hyprlandSessionPresent,
              },
              linuxBackends: options.backends,
            }),
          ),
        ),
      ),
    );
  }

  it("does not wait on a wedged session bus, and adopts the tier once selection answers", async () => {
    const bus = Promise.withResolvers<boolean>();
    const nested = new FakeComputerBackend();
    const started = performance.now();
    await withLinuxService(
      {
        busNameHasOwner: () => bus.promise,
        hyprlandSessionPresent: () => false,
        backends: { nested: () => nested },
      },
      async (service) => {
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(service.supported).toBe(true);
        expect(service.availability).toMatchObject({ kind: "checking" });
        expect((await service.manager.getStatus()).availability).toMatchObject({
          kind: "checking",
        });
        await expect(service.manager.listWindows()).rejects.toMatchObject({ retryable: true });
        // Every Linux tier's profile, before the tier is known.
        expect(service.manager.guidanceProfile).toEqual({ dialect: "linux", dedicatedSeat: true });
        expect(nested.calls).toEqual([]);

        bus.resolve(false);
        await vi.waitFor(() =>
          expect(service.availability).toEqual({ kind: "available", backend: "fake" }),
        );
        expect((await service.manager.getStatus()).availability).toEqual({
          kind: "available",
          backend: "fake",
        });
        await service.manager.listWindows();
        expect(nested.callsFor("listWindows")).toHaveLength(1);
      },
    );
  });

  it("re-selects when the selected tier's desktop is gone for good", async () => {
    let hyprlandLive = true;
    const hyprland = new FakeComputerBackend();
    const nested = new FakeComputerBackend();
    await withLinuxService(
      {
        busNameHasOwner: async () => false,
        hyprlandSessionPresent: () => hyprlandLive,
        backends: { hyprland: () => hyprland, nested: () => nested },
      },
      async (service) => {
        await service.manager.listWindows();
        const hyprlandReads = hyprland.callsFor("listWindows").length;
        expect(hyprlandReads).toBeGreaterThan(0);

        hyprlandLive = false;
        hyprland.emitDesktopGone("The Hyprland instance exited.");
        await vi.waitFor(() => expect(hyprland.callsFor("dispose")).toHaveLength(1));
        await service.manager.listWindows();
        expect(nested.callsFor("listWindows").length).toBeGreaterThan(0);
        expect(hyprland.callsFor("listWindows")).toHaveLength(hyprlandReads);
      },
    );
  });

  it("swaps the re-selected tier in between operations, never inside one", async () => {
    let hyprlandLive = true;
    const hyprland = new FakeComputerBackend();
    const nested = new FakeComputerBackend();
    await withLinuxService(
      {
        busNameHasOwner: async () => false,
        hyprlandSessionPresent: () => hyprlandLive,
        backends: { hyprland: () => hyprland, nested: () => nested },
      },
      async (service) => {
        const manager = service.manager;
        const targeted = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const action = manager.withAgentActivity("thread-1", async () => {
          await manager.moveCursor("thread-1", { x: 5, y: 5 });
          targeted.resolve();
          await resume.promise;
          return await manager.click("thread-1", { x: 10, y: 10 });
        });
        await targeted.promise;

        hyprlandLive = false;
        hyprland.emitDesktopGone("The Hyprland instance exited.");
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Selection has answered, and the swap is waiting for the action.
        expect(hyprland.callsFor("dispose")).toHaveLength(0);
        resume.resolve();

        await expect(action).rejects.toMatchObject({ retryable: true });
        await vi.waitFor(() => expect(hyprland.callsFor("dispose")).toHaveLength(1));
        expect(nested.callsFor("click")).toHaveLength(0);
        expect(hyprland.callsFor("click")).toHaveLength(0);
      },
    );
  });

  it("never re-selects a tier an explicit override named", async () => {
    const hyprland = new FakeComputerBackend();
    const nested = new FakeComputerBackend();
    await withLinuxService(
      {
        env: { SYNARA_COMPUTER_BACKEND: "hyprland" },
        busNameHasOwner: async () => false,
        hyprlandSessionPresent: () => false,
        backends: { hyprland: () => hyprland, nested: () => nested },
      },
      async (service) => {
        hyprland.emitDesktopGone();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await service.manager.listWindows().catch(() => undefined);
        expect(hyprland.callsFor("listWindows").length).toBeGreaterThan(0);
        expect(hyprland.callsFor("dispose")).toHaveLength(0);
        expect(nested.calls).toEqual([]);
      },
    );
  });

  it("hands the macOS host its Cua backend directly, probed before startup continues", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          const backend = backendOf(service);
          expect(types.isProxy(backend)).toBe(false);
          expect(backend).toBeInstanceOf(CuaComputerBackend);
          expect(service.availability.kind).not.toBe("checking");
        }).pipe(
          Effect.provide(makeComputerServiceLayer({ platform: "darwin", selection: { env: {} } })),
        ),
      ),
    );
  });
});
