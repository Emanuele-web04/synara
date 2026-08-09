import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AgentProfileRepositoryLive } from "./AgentProfileRepository.ts";
import {
  AgentProfileService,
  AgentProfileServiceLive,
  ExternalAgentProfileError,
} from "./AgentProfileService.ts";
import { legacyAcpProfileId, legacyAcpRevisionId } from "./agentProfileIdentity.ts";

const testLayer = AgentProfileServiceLive.pipe(
  Layer.provideMerge(AgentProfileRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerSecretStoreLive.pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "synara-external-agent-profiles-test-" }),
      ),
      Layer.provide(NodeServices.layer),
    ),
  ),
);

const layer = it.layer(testLayer);

const launch = { kind: "command" as const, command: "cline", args: [] as string[] };

layer("AgentProfileService", (it) => {
  it.effect("creates two independent profiles usable simultaneously", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const first = yield* service.createProfile({
        name: "Cline",
        displayName: "Cline",
        connectorKind: "acp",
        launch,
        credentialRefs: [],
        provenance: { source: "manual" },
      });
      const second = yield* service.createProfile({
        name: "Roo",
        displayName: "Roo Code",
        connectorKind: "acp",
        launch: { kind: "command", command: "roo", args: [] },
        credentialRefs: [],
        provenance: { source: "manual" },
      });
      assert.notEqual(first.profile.profileId, second.profile.profileId);

      const listed = yield* service.listProfiles();
      assert.strictEqual(listed.length, 2);
      const byId = new Map(listed.map((profile) => [profile.profileId, profile]));
      assert.strictEqual(byId.get(first.profile.profileId)?.name, "Cline");
      assert.strictEqual(byId.get(second.profile.profileId)?.name, "Roo");

      const detail = yield* service.getProfile(first.profile.profileId);
      assert.strictEqual(detail.currentRevision.displayName, "Cline");
      assert.strictEqual(detail.revisions.length, 1);
    }),
  );

  it.effect("editing a profile creates a new revision and reuses identical content", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile({
        name: "Cline",
        displayName: "Cline",
        connectorKind: "acp",
        launch,
        credentialRefs: [],
        provenance: { source: "manual" },
      });

      const edited = yield* service.updateProfile({
        profileId: created.profile.profileId,
        displayName: "Cline (renamed)",
        launch,
        credentialRefs: [],
      });
      assert.notEqual(edited.profile.currentRevisionId, created.profile.currentRevisionId);
      assert.isFalse(edited.reused);

      // Editing back to the original content reuses the deduped revision.
      const reverted = yield* service.updateProfile({
        profileId: created.profile.profileId,
        displayName: "Cline",
        launch,
        credentialRefs: [],
      });
      assert.isTrue(reverted.reused);
      assert.strictEqual(reverted.revision.revisionId, created.revision.revisionId);

      const detail = yield* service.getProfile(created.profile.profileId);
      // Reverting to the original content reuses the original revision, so the
      // content-addressed history collapses back to a single revision.
      assert.strictEqual(detail.revisions.length, 1);
      assert.strictEqual(detail.currentRevision.revisionId, created.revision.revisionId);
    }),
  );

  it.effect("refuses new sessions for tombstoned profiles but keeps history readable", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile({
        name: "Cline",
        displayName: "Cline",
        connectorKind: "acp",
        launch,
        credentialRefs: [],
        provenance: { source: "manual" },
      });
      yield* service.tombstoneProfile(created.profile.profileId);

      const launchResult = yield* Effect.flip(
        service.resolveSessionLaunch({
          profileId: created.profile.profileId,
          revisionId: created.revision.revisionId,
        }),
      );
      assert.instanceOf(launchResult, ExternalAgentProfileError);
      assert.strictEqual(launchResult.code, "profile-removed");

      // Historical thread reads still resolve the pinned revision.
      const detail = yield* service.getProfile(created.profile.profileId);
      assert.strictEqual(detail.profile.status, "tombstoned");
      assert.strictEqual(detail.currentRevision.revisionId, created.revision.revisionId);
    }),
  );

  it.effect("resolves a session launch with credential expansion", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const secrets = yield* ServerSecretStore;
      const created = yield* service.createProfile({
        name: "Cline",
        displayName: "Cline",
        connectorKind: "acp",
        launch: { kind: "command", command: "cline", args: [], envRefs: [] },
        credentialRefs: [{ name: "api-key", envKey: "CLINE_API_KEY", required: true }],
        provenance: { source: "manual" },
      });
      yield* secrets.set(
        `external-agent-profile:${created.profile.profileId}:api-key`,
        new TextEncoder().encode("secret-value"),
      );

      const resolved = yield* service.resolveSessionLaunch({
        profileId: created.profile.profileId,
        revisionId: created.revision.revisionId,
      });
      assert.strictEqual(resolved.profile.profileId, created.profile.profileId);
      assert.strictEqual(resolved.env.CLINE_API_KEY, "secret-value");
    }),
  );

  it.effect("migrates the legacy slot deterministically on session resolution", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const resolved = yield* service.resolveSessionLaunch({
        profileId: legacyAcpProfileId(),
        revisionId: legacyAcpRevisionId(),
      });
      assert.strictEqual(resolved.profile.profileId, legacyAcpProfileId());
      assert.strictEqual(resolved.profile.name, "Legacy ACP Agent");

      // Idempotent: a second resolution does not duplicate the profile.
      const again = yield* service.resolveSessionLaunch({
        profileId: legacyAcpProfileId(),
        revisionId: legacyAcpRevisionId(),
      });
      assert.strictEqual(again.profile.profileId, legacyAcpProfileId());
      const listed = yield* service.listProfiles();
      assert.strictEqual(
        listed.filter((profile) => profile.profileId === legacyAcpProfileId()).length,
        1,
      );
    }),
  );
});
