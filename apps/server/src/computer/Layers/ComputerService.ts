import { join } from "node:path";
import { ServerConfig } from "../../config.ts";
import { Effect, Layer, Option } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { CUA_HOST_SOCKET_ENV } from "@synara/shared/cuaDriverProtocol";
import { ComputerManager } from "../ComputerManager.ts";
import { CuaComputerBackend } from "../CuaComputerBackend.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { UnavailableComputerBackend } from "../UnavailableComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import type { ComputerBackend } from "../ComputerBackend.ts";
import { resolveBrowserHostCapability } from "../../browserAutomation/browserHostRpcClient.ts";

export interface ComputerServiceLiveOptions {
  /** Inject a real or fake backend. */
  readonly backend?: ComputerBackend;
  /** Test/embedding override for the final availability decision. */
  readonly supported?: boolean;
  /** Test override for the host platform; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

let warnedMissingControlStatePath = false;

export function makeComputerServiceLayer(options: ComputerServiceLiveOptions = {}) {
  return Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const requestedBackend = process.env.SYNARA_COMPUTER_BACKEND?.trim().toLowerCase();
      const unavailableAvailability: ComputerAvailability =
        platform === "linux"
          ? {
              kind: "backend-unavailable",
              message: "No computer backend is available on this server.",
            }
          : { kind: "unsupported-platform", platform };
      // macOS runs the bundled host the desktop app provisions; on other
      // platforms the same backend is routable when a host endpoint is
      // configured explicitly (the provisioned upstream driver serving the
      // same socket protocol). No endpoint means no backend — the gate is
      // reachability, never platform optimism.
      const hostEndpoint = process.env[CUA_HOST_SOCKET_ENV]?.trim();
      const backend =
        options.backend ??
        (requestedBackend === "fake" ? new FakeComputerBackend() : undefined) ??
        (platform === "darwin" || hostEndpoint
          ? new CuaComputerBackend({
              capability: resolveBrowserHostCapability() ?? undefined,
            })
          : undefined) ??
        new UnavailableComputerBackend(
          `No computer backend is configured for this server running on ${platform}.`,
          { availability: unavailableAvailability },
        );
      const config = yield* Effect.serviceOption(ServerConfig);
      if (Option.isNone(config) && !warnedMissingControlStatePath) {
        warnedMissingControlStatePath = true;
        yield* Effect.logWarning(
          "computer control state path unavailable; using in-memory control state",
        );
      }
      const manager = new ComputerManager({
        backend,
        ...(Option.isSome(config)
          ? {
              controlStatePath: join(config.value.stateDir, "computer-control.json"),
              // Beside the control state: the bounded mutating-call audit log,
              // local-only and dropped-oldest past its caps.
              auditLogPath: join(config.value.stateDir, "computer-audit.jsonl"),
            }
          : {}),
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
      let availability: ComputerAvailability;
      if (options.supported === undefined) {
        // The passive probe, never the establishing read. Boot runs for every
        // user of every build, long before anyone has asked for a desktop.
        availability = yield* Effect.promise(() => backend.probeAvailability());
      } else if (options.supported) {
        availability = { kind: "available", backend: "test-override" };
      } else {
        availability = {
          kind: "backend-unavailable",
          message: "Computer support is disabled by the service configuration.",
        };
      }
      return {
        // Supported backends remain routable even before setup grants access.
        supported: options.supported ?? !(backend instanceof UnavailableComputerBackend),
        availability,
        manager,
      } satisfies ComputerServiceShape;
    }),
  );
}

export const ComputerServiceLive = makeComputerServiceLayer();
