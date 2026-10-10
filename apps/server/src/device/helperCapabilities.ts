/** the private symbols behind each capability move independently between Xcode releases — kept away from process spawning so both parse and mapping are unit-testable against synthetic payloads */

import {
  DEVICE_CAPABILITY_LABELS,
  type DeviceAvailability,
  type DeviceCapabilityId,
  type DeviceCapabilityStatus,
  type DeviceToolchain,
} from "@synara/contracts";

/** every capability, in the order the pane lists them */
export const DEVICE_CAPABILITY_IDS = [
  "framebuffer",
  "hid",
  "accessibility",
  "encoder",
] as const satisfies readonly DeviceCapabilityId[];

export interface HelperProbeResult {
  readonly ok: boolean;
  readonly capabilities: readonly DeviceCapabilityStatus[];
  readonly toolchain: DeviceToolchain | undefined;
  /** a whole-helper failure — frameworks wouldn't load, CoreSimulator unreachable */
  readonly error: string | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const parseToolchain = (value: unknown): DeviceToolchain | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const toolchain: DeviceToolchain = {
    xcodeVersion: asNonEmptyString(record["xcodeVersion"]),
    xcodeBuild: asNonEmptyString(record["xcodeBuild"]),
    macOS: asNonEmptyString(record["macOS"]),
  };
  return toolchain.xcodeVersion === undefined &&
    toolchain.xcodeBuild === undefined &&
    toolchain.macOS === undefined
    ? undefined
    : toolchain;
};

/** an entry the helper didn't report is broken rather than assumed working — an older helper predating a capability can't provide it, and claiming otherwise surfaces as a mystery failure at the point of use */
const parseCapability = (id: DeviceCapabilityId, raw: unknown): DeviceCapabilityStatus => {
  if (raw === "ok") return { id, ok: true };
  const record = asRecord(raw);
  if (!record) {
    return { id, ok: false, detail: "The device helper did not report this capability." };
  }
  return {
    id,
    ok: false,
    missingSymbol: asNonEmptyString(record["missingSymbol"]),
    detail: asNonEmptyString(record["error"]) ?? asNonEmptyString(record["purpose"]),
  };
};

/** never throws — a helper emitting garbage is a degraded helper, and the pane must render that rather than crash */
export const parseHelperProbe = (stdout: string): HelperProbeResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      capabilities: DEVICE_CAPABILITY_IDS.map((id) => ({
        id,
        ok: false,
        detail: "The device helper preflight returned unreadable output.",
      })),
      toolchain: undefined,
      error: "The device helper preflight returned unreadable output.",
    };
  }

  const record = asRecord(parsed);
  if (!record) {
    return {
      ok: false,
      capabilities: DEVICE_CAPABILITY_IDS.map((id) => ({
        id,
        ok: false,
        detail: "The device helper preflight returned unreadable output.",
      })),
      toolchain: undefined,
      error: "The device helper preflight returned unreadable output.",
    };
  }

  const capabilitiesRecord = asRecord(record["capabilities"]);
  const error = asNonEmptyString(record["error"]);

  // a helper too old to report capabilities still answers `ok` — trust that rather than reporting four phantom breakages
  if (!capabilitiesRecord) {
    const ok = record["ok"] === true;
    return {
      ok,
      capabilities: [],
      toolchain: parseToolchain(record["toolchain"]),
      error: ok ? undefined : (error ?? "The device helper preflight failed."),
    };
  }

  const capabilities = DEVICE_CAPABILITY_IDS.map((id) =>
    parseCapability(id, capabilitiesRecord[id]),
  );

  return {
    ok: record["ok"] === true && capabilities.every((capability) => capability.ok),
    capabilities,
    toolchain: parseToolchain(record["toolchain"]),
    error,
  };
};

/** a capability failure is deliberately not `setup-required` — nothing to install, so the pane opens and working capabilities keep working */
export const availabilityFromProbe = (probe: HelperProbeResult): DeviceAvailability => {
  const broken = probe.capabilities.filter((capability) => !capability.ok);

  if (broken.length === 0) {
    // frameworks that wouldn't load leave no per-capability detail — a helper failure, not a degraded one
    if (!probe.ok && probe.error !== undefined) {
      return { kind: "helper-unavailable", message: probe.error };
    }
    return probe.capabilities.length > 0
      ? { kind: "available", capabilities: probe.capabilities, toolchain: probe.toolchain }
      : { kind: "available" };
  }

  // everything broken means the helper is unusable, not partially usable
  if (broken.length === probe.capabilities.length) {
    return {
      kind: "helper-unavailable",
      message: probe.error ?? describeBrokenCapabilities(broken, probe.toolchain),
    };
  }

  return { kind: "degraded", capabilities: probe.capabilities, toolchain: probe.toolchain };
};

/** names the toolchain a failure was measured on, when reported */
export const describeToolchain = (toolchain: DeviceToolchain | undefined): string => {
  if (!toolchain) return "";
  const version = toolchain.xcodeVersion;
  const build = toolchain.xcodeBuild;
  if (version && build) return `Xcode ${version} (${build})`;
  if (version) return `Xcode ${version}`;
  if (build) return `Xcode build ${build}`;
  return "";
};

/** a one-line summary of what is broken, for logs and messages */
export const describeBrokenCapabilities = (
  broken: readonly DeviceCapabilityStatus[],
  toolchain: DeviceToolchain | undefined,
): string => {
  const names = broken.map((capability) => DEVICE_CAPABILITY_LABELS[capability.id].toLowerCase());
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const where = describeToolchain(toolchain);
  return `${list} unavailable${where ? ` with ${where}` : ""}`;
};

/** names the capability and the Xcode it broke on — the actionable fact is "this Xcode moved a symbol", not "the call failed" */
export const capabilityUnavailableMessage = (
  capability: DeviceCapabilityStatus,
  toolchain: DeviceToolchain | undefined,
): string => {
  const label = DEVICE_CAPABILITY_LABELS[capability.id];
  const where = describeToolchain(toolchain);
  const symbol = capability.missingSymbol;
  const because = symbol
    ? ` The device helper could not resolve '${symbol}'.`
    : capability.detail
      ? ` ${capability.detail}`
      : "";
  return `${label} is unavailable${where ? ` with ${where}` : ""}.${because}`;
};
