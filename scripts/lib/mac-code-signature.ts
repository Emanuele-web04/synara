// FILE: mac-code-signature.ts
// Purpose: Inspects macOS code signatures for release guardrails.
// Layer: Desktop release helper
// Depends on: macOS codesign CLI output format.

import { spawnSync } from "node:child_process";

export interface MacCodeSignatureInspection {
  readonly details: string;
  readonly isStable: boolean;
}

export function inspectMacCodeSignature(appBundlePath: string): MacCodeSignatureInspection {
  const result = spawnSync("codesign", ["-dvvv", appBundlePath], {
    encoding: "utf8",
  });
  return inspectMacCodeSignatureOutput(
    result.status ?? 1,
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
}

export function inspectMacCodeSignatureOutput(
  exitCode: number,
  output: string,
): MacCodeSignatureInspection {
  const details = output.trim();
  if (exitCode !== 0) {
    return {
      isStable: false,
      details: details ? `codesign output: ${details}` : "codesign failed with no output.",
    };
  }

  const isAdHoc = /\bSignature=adhoc\b/.test(details);
  const hasStableTeam = /\bTeamIdentifier=(?!not set\b).+/.test(details);

  return {
    isStable: !isAdHoc && hasStableTeam,
    details: details
      .split("\n")
      .filter((line) => /^(Signature|TeamIdentifier)=/.test(line))
      .join(" "),
  };
}
