import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps profile, discovery, and evidence RPCs behind owner authorization", () => {
  const source = readFileSync(new URL("./wsRpc.ts", import.meta.url), "utf8");
  expect(source).toMatch(
    /const ownerExternalAgentRpc[\s\S]*?requireWsOwnerSession\.pipe\(Effect\.andThen\(rpcEffect/,
  );
  for (const method of [
    "capabilityEvidenceRecord",
    "capabilityEvidenceQuery",
    "capabilityEvidenceInvalidate",
    "capabilityEvidenceDemote",
    "capabilityEvidenceBadge",
    "runtimeTurnFeedbackRecord",
    "serverListExternalAgentProfiles",
    "serverGetExternalAgentProfile",
    "serverCreateExternalAgentProfile",
    "serverUpdateExternalAgentProfile",
    "serverTombstoneExternalAgentProfile",
    "serverListConnectionCandidates",
    "serverResolveConnectionPlan",
    "serverQuarantineExternalAgentProfile",
    "serverUnquarantineExternalAgentProfile",
    "serverRecertifyExternalAgentProfile",
  ])
    expect(source).toMatch(
      new RegExp(`\\[WS_METHODS\\.${method}\\]:[^=]*=>\\s*ownerExternalAgentRpc\\(`),
    );
});
