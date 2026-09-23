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
   * Linux tiers decide first, and Cua is what remains when none claims the
   * host. Naming it explicitly reaches it on any platform.
   */
  it("keeps Cua as the Linux fallback and the explicit choice", async () => {
    vi.stubEnv("SYNARA_CUA_HOST_SOCKET", "/tmp/synara-cua-test.sock");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ComputerService;
            expect(service.supported).toBe(true);
            expect(service.availability).not.toMatchObject({ kind: "unsupported-platform" });
            // The Cua host, observing a Linux desktop it does not drive.
            expect(backendOf(service)).toBeInstanceOf(CuaComputerBackend);
            expect(service.manager.guidanceProfile).toEqual({
              dialect: "linux",
              dedicatedSeat: false,
            });
          }).pipe(
            Effect.provide(
              makeComputerServiceLayer({
                platform: "linux",
                selection: { env: { SYNARA_CUA_HOST_SOCKET: "/tmp/synara-cua-test.sock" } },
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
            expect(backendOf(service)).toBeInstanceOf(CuaComputerBackend);
          }).pipe(Effect.provide(makeComputerServiceLayer({ platform: "win32" }))),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a Linux host with no tier and no host endpoint rather than faking one", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ComputerService;
          expect(service.supported).toBe(false);
          expect(service.availability).toEqual({
            kind: "backend-unavailable",
            message: "No computer backend is available on this server.",
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
