import type { ProviderAgentDescriptor } from "@t3tools/contracts";
import { Effect } from "effect";

import {
  HERMES_ACTIVE_PROFILE_DESCRIPTION,
  listHermesProfileInventory,
  resolveDefaultHermesProfile,
  resolveHermesProfileHomeFromInventory,
} from "./hermesProfileInventory.ts";
import { trimToUndefined } from "./geminiValue.ts";

export { HERMES_ACTIVE_PROFILE_DESCRIPTION } from "./hermesProfileInventory.ts";

export type HermesProfileRecord = {
  readonly name: string;
  readonly model?: string;
  readonly alias?: string;
  readonly path?: string;
  readonly isActive?: boolean;
};

export function parseHermesProfileListOutput(output: string): ReadonlyArray<HermesProfileRecord> {
  const profiles: HermesProfileRecord[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || (line.includes("Profile") && line.includes("Model") && line.includes("Gateway"))) {
      continue;
    }
    if (/^[-─\s]+$/u.test(line)) {
      continue;
    }

    const match = line.match(/^\s*[◆●]?\s*(\S+)\s+(\S+)/u);
    if (!match) {
      continue;
    }

    const name = match[1]?.trim();
    const model = match[2]?.trim();
    if (!name || name === "—" || seen.has(name)) {
      continue;
    }

    seen.add(name);
    profiles.push({
      name,
      ...(model && model !== "—" ? { model } : {}),
      isActive: rawLine.includes("◆") || rawLine.includes("●"),
    });
  }

  return profiles;
}

export function parseHermesProfileShowOutput(output: string): HermesProfileRecord | undefined {
  let name: string | undefined;
  let path: string | undefined;
  let model: string | undefined;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    const profileMatch = line.match(/^Profile:\s*(.+)$/iu);
    if (profileMatch) {
      name = trimToUndefined(profileMatch[1]);
      continue;
    }
    const pathMatch = line.match(/^Path:\s*(.+)$/iu);
    if (pathMatch) {
      path = trimToUndefined(pathMatch[1]);
      continue;
    }
    const modelMatch = line.match(/^Model:\s*(\S+)/iu);
    if (modelMatch) {
      model = trimToUndefined(modelMatch[1]);
    }
  }

  if (!name) {
    return undefined;
  }

  return {
    name,
    ...(path ? { path } : {}),
    ...(model ? { model } : {}),
  };
}

export function listHermesProfiles(binaryPath?: string) {
  return listHermesProfileInventory(binaryPath);
}

export function resolveHermesProfileHome(input: {
  readonly binaryPath?: string;
  readonly profile?: string;
}): Effect.Effect<string | undefined, never> {
  const profileName = trimToUndefined(input.profile);
  if (!profileName) {
    return Effect.succeed(undefined);
  }

  return resolveHermesProfileHomeFromInventory({
    ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
    profile: profileName,
  });
}

export { resolveDefaultHermesProfile } from "./hermesProfileInventory.ts";

export function toHermesProfileAgents(
  profiles: ReadonlyArray<HermesProfileRecord>,
): ReadonlyArray<ProviderAgentDescriptor> {
  return profiles.map((profile) => ({
    name: profile.name,
    displayName: trimToUndefined(profile.alias) ?? profile.name,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.isActive ? { description: HERMES_ACTIVE_PROFILE_DESCRIPTION } : {}),
  }));
}
