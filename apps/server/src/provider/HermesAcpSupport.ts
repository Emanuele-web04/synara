import * as nodePath from "node:path";

import type { ProviderApprovalDecision } from "@t3tools/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./acp/AcpSessionRuntime.ts";
import { resolveHermesAcpSpawn, selectHermesAuthMethodId } from "./hermesAcp.ts";

export function buildHermesSpawnEnv(input: {
  readonly profileHome?: string;
}): NodeJS.ProcessEnv {
  if (!input.profileHome?.trim()) {
    return process.env;
  }
  return { ...process.env, HERMES_HOME: input.profileHome.trim() };
}

export function buildHermesAcpSpawnInput(input: {
  readonly binaryPath?: string;
  readonly cwd: string;
  readonly profileHome?: string;
}): AcpSpawnInput {
  const acpSpawn = resolveHermesAcpSpawn(input.binaryPath);
  return {
    command: acpSpawn.command,
    args: acpSpawn.args,
    cwd: input.cwd,
    env: buildHermesSpawnEnv({ profileHome: input.profileHome }),
  };
}

export const makeHermesAcpRuntime = (
  input: {
    readonly binaryPath?: string;
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly cwd: string;
    readonly profileHome?: string;
    readonly resumeSessionId?: string;
  } & Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: buildHermesAcpSpawnInput({
          binaryPath: input.binaryPath,
          cwd: input.cwd,
          profileHome: input.profileHome,
        }),
        cwd: input.cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        clientInfo: { name: "dp-code", version: "0.0.0" },
        selectAuthMethodId: selectHermesAuthMethodId,
        ...(input.requestLogger ? { requestLogger: input.requestLogger } : {}),
        ...(input.protocolLogging ? { protocolLogging: input.protocolLogging } : {}),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

type HermesPermissionOption = {
  readonly kind: string;
  readonly optionId: string;
};

function pickHermesPermissionOption(
  options: ReadonlyArray<HermesPermissionOption>,
  kinds: ReadonlyArray<string>,
): string | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    const optionId = match?.optionId?.trim();
    if (optionId) {
      return optionId;
    }
  }
  return undefined;
}

export function resolveHermesPermissionOutcome(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<HermesPermissionOption>,
): string | undefined {
  switch (decision) {
    case "cancel":
      return undefined;
    case "accept":
      return pickHermesPermissionOption(options, ["allow_once", "allow_always"]);
    case "acceptForSession":
      return pickHermesPermissionOption(options, ["allow_session", "allow_once", "allow_always"]);
    case "decline":
    default:
      return pickHermesPermissionOption(options, ["reject_once", "reject_always"]);
  }
}

export function resolveHermesAutoApprovedOption(
  request: EffectAcpSchema.RequestPermissionRequest,
  runtimeMode: "approval-required" | "full-access" | undefined,
): string | undefined {
  if (runtimeMode !== "full-access") {
    return undefined;
  }

  const options = request.options.map((option) => ({
    kind: option.kind,
    optionId: option.optionId,
  }));

  return (
    pickHermesPermissionOption(options, ["allow_always", "allow_session", "allow_once"]) ??
    undefined
  );
}

export function shouldSetHermesModel(model: string | undefined): model is string {
  const trimmed = model?.trim();
  return trimmed !== undefined && trimmed.length > 0 && trimmed !== "hermes-agent";
}

export function normalizeHermesModelSlug(model: string): string {
  const trimmed = model.trim();
  if (!trimmed || trimmed === "hermes-agent") {
    return trimmed;
  }
  if (trimmed.includes(":")) {
    return trimmed;
  }
  return trimmed;
}

export function resolveHermesSessionCwd(
  inputCwd: string | undefined,
  fallbackCwd: string | undefined,
): string | undefined {
  const requestedCwd = inputCwd?.trim();
  if (requestedCwd) {
    return nodePath.resolve(requestedCwd);
  }
  const resolvedFallback = fallbackCwd?.trim();
  return resolvedFallback ? nodePath.resolve(resolvedFallback) : undefined;
}
