/** the helper reports real geometry only after attaching to a booted simulator — far too late for the picker; every device type ships a profile.plist readable while shut down; the helper's measurement still wins when it disagrees */
import * as path from "node:path";

import type { DeviceFamily, DeviceGeometry } from "@synara/contracts";

import type { runProcess } from "../processRunner.ts";

export interface DeviceTypeProfile {
  readonly family: DeviceFamily;
  readonly geometry: DeviceGeometry;
}

/** identifier -> profile, read from the installed simulator device types */
export type DeviceTypeCatalogue = ReadonlyMap<string, DeviceTypeProfile>;

/** unrecognised families (watch, TV) yield null and fall back to the device name — guessing "phone" for an Apple TV is worse */
function familyFor(productFamily: unknown): DeviceFamily | null {
  switch (String(productFamily)) {
    case "iPhone":
    case "iPod touch":
      return "phone";
    case "iPad":
      return "tablet";
    default:
      return null;
  }
}

interface SimctlDeviceType {
  readonly identifier?: unknown;
  readonly productFamily?: unknown;
  readonly bundlePath?: unknown;
}

export interface ParsedDeviceType {
  readonly identifier: string;
  readonly family: DeviceFamily;
  readonly profilePath: string;
}

/** entries missing an identifier, bundle, or drawable family are dropped rather than half-filled */
export function parseSimctlDeviceTypes(json: string): readonly ParsedDeviceType[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (parsed as { devicetypes?: unknown }).devicetypes;
  if (!Array.isArray(list)) return [];

  const entries: ParsedDeviceType[] = [];
  for (const raw of list as readonly SimctlDeviceType[]) {
    const identifier = typeof raw.identifier === "string" ? raw.identifier : null;
    const bundlePath = typeof raw.bundlePath === "string" ? raw.bundlePath : null;
    const family = familyFor(raw.productFamily);
    if (!identifier || !bundlePath || family === null) continue;
    entries.push({
      identifier,
      family,
      profilePath: path.join(bundlePath, "Contents", "Resources", "profile.plist"),
    });
  }
  return entries;
}

/** the plist reports pixels + scale; the contract carries points (the unit input is injected in); a missing/bogus field yields null so the device keeps whatever the helper measures */
export function parseDeviceTypeProfile(json: string): DeviceGeometry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const profile = parsed as Record<string, unknown>;
  const read = (key: string): number | null => {
    const value = profile[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  };
  const pixelWidth = read("mainScreenWidth");
  const pixelHeight = read("mainScreenHeight");
  const scale = read("mainScreenScale");
  if (pixelWidth === null || pixelHeight === null || scale === null) return null;
  return {
    pointWidth: Math.round(pixelWidth / scale),
    pointHeight: Math.round(pixelHeight / scale),
    scale,
  };
}

/** ~120 short-lived processes on a full Xcode, so callers cache for the process lifetime; any single failure is skipped rather than costing the other 119 */
export async function readDeviceTypeCatalogue(input: {
  readonly run: typeof runProcess;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<DeviceTypeCatalogue> {
  const listing = await input
    .run("xcrun", ["simctl", "list", "devicetypes", "--json"], {
      timeoutMs: 30_000,
      allowNonZeroExit: true,
      outputMode: "truncate",
      env: input.env,
    })
    .catch(() => null);
  if (!listing || listing.code !== 0) return new Map();

  const entries = parseSimctlDeviceTypes(listing.stdout);
  const catalogue = new Map<string, DeviceTypeProfile>();
  await Promise.all(
    entries.map(async (entry) => {
      const result = await input
        .run("plutil", ["-convert", "json", "-o", "-", entry.profilePath], {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        })
        .catch(() => null);
      if (!result || result.code !== 0) return;
      const geometry = parseDeviceTypeProfile(result.stdout);
      if (!geometry) return;
      catalogue.set(entry.identifier, { family: entry.family, geometry });
    }),
  );
  return catalogue;
}
