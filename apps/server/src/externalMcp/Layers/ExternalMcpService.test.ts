import { ProjectId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ExternalMcpRepositoryLive } from "./ExternalMcpRepository.ts";
import { ExternalMcpService } from "../Services/ExternalMcpService.ts";
import { ExternalMcpServiceLive } from "./ExternalMcpService.ts";

const project = {
  id: "project-allowed",
  title: "Allowed project",
  workspaceRoot: "/tmp/allowed-project",
};

const insertProject = (input: typeof project) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${input.id}, ${input.title}, ${input.workspaceRoot}, '[]',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', NULL
      )
    `;
  });

const loadServiceWithProject = Effect.gen(function* () {
  yield* insertProject(project);
  return yield* ExternalMcpService;
});

const layer = ExternalMcpServiceLive.pipe(
  Layer.provideMerge(ExternalMcpRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(
    Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () => Effect.die("project authorization must not hydrate a shell snapshot"),
      getThreadShellById: () => Effect.succeed({ _tag: "None" }),
    } as never),
  ),
  Layer.provide(Layer.succeed(ServerConfig, { baseDir: "/tmp/synara-test" } as never)),
);

const run = <A, E>(effect: Effect.Effect<A, E, ExternalMcpService | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("ExternalMcpService", () => {
  it("keeps browser, server, and provider-session tokens outside the MCP audience", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* loadServiceWithProject;
        for (const token of [
          "sagw_session_provider-token",
          "eyJraW5kIjoic2Vzc2lvbiJ9.browser-session",
          "generic-server-auth-token",
        ]) {
          const result = yield* service.verifyCredential(token).pipe(Effect.exit);
          expect(result._tag).toBe("Failure");
        }
      }),
    );
  });

  it("issues one pairing exchange, verifies it, and revokes it immediately", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* loadServiceWithProject;
        const created = yield* service.createIntegration({
          name: "Codex",
          projectIds: [ProjectId.makeUnsafe("project-allowed")],
          capabilities: ["projects:read", "tasks:create", "tasks:read", "tasks:wait"],
          expiresInDays: 30,
        });
        expect(created.setupCommand).toContain("mcp");
        expect(created.setupCommand).toContain("pair");
        expect(created.setupCommand).toContain("syn_pair_v1_");
        expect(created.stdio.command).toBe(process.execPath);
        expect(created.stdio.args).toContain(created.integration.integrationId);
        expect(created.stdio.args).toContain("/tmp/synara-test");
        expect(JSON.stringify(created.integration)).not.toContain("credential");
        const credential = "syn_mcp_v1_client-generated-secret";
        const paired = yield* service.pair(created.pairingCode, credential);
        expect(paired.credential).toBe(credential);
        expect((yield* service.verifyCredential(paired.credential)).integration.integrationId).toBe(
          created.integration.integrationId,
        );
        const retry = yield* service.pair(created.pairingCode, credential);
        expect(retry.credential).toBe(credential);
        const secondPair = yield* service
          .pair(created.pairingCode, "syn_mcp_v1_different-secret")
          .pipe(Effect.exit);
        expect(secondPair._tag).toBe("Failure");
        expect(yield* service.revokeIntegration(created.integration.integrationId)).toBe(true);
        const revoked = yield* service.verifyCredential(paired.credential).pipe(Effect.exit);
        expect(revoked._tag).toBe("Failure");
      }),
    );
  });

  it("grants every current and future project with the all-projects scope", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* loadServiceWithProject;
        const created = yield* service.createIntegration({
          name: "All projects",
          projectScope: "all",
          capabilities: ["projects:read", "tasks:create", "tasks:read", "tasks:wait"],
        });
        expect(created.integration.projectScope).toBe("all");
        expect(created.integration.allowedProjects.map((grant) => grant.projectId)).toEqual([
          "project-allowed",
        ]);
        const paired = yield* service.pair(created.pairingCode, "syn_mcp_v1_all-scope-secret");
        const client = yield* service.verifyCredential(paired.credential);
        expect(client.allowedProjectIds.has("project-allowed")).toBe(true);
        yield* insertProject({
          id: "project-added-later",
          title: "Added later",
          workspaceRoot: "/tmp/added-later",
        });
        const refreshed = yield* service.verifyCredential(paired.credential);
        expect(refreshed.allowedProjectIds.has("project-added-later")).toBe(true);
        yield* service.assertProject(refreshed, "project-added-later");
        yield* service.assertActive(created.integration.integrationId);
      }),
    );
  });

  it("requires at least one project when the scope is selected", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* loadServiceWithProject;
        const result = yield* service
          .createIntegration({
            name: "No projects",
            capabilities: ["projects:read"],
          })
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  it("rejects unknown project grants at management time", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* loadServiceWithProject;
        const result = yield* service
          .createIntegration({
            name: "Unknown project",
            projectIds: [ProjectId.makeUnsafe("project-not-allowed")],
            capabilities: ["projects:read"],
          })
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  it("surfaces repository audit completion failures to the gateway boundary", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* loadServiceWithProject;
        const sql = yield* SqlClient.SqlClient;
        const created = yield* service.createIntegration({
          name: "Audit failure",
          projectIds: [ProjectId.makeUnsafe("project-allowed")],
          capabilities: ["projects:read"],
        });
        const paired = yield* service.pair(created.pairingCode, "syn_mcp_v1_audit-failure-secret");
        const client = yield* service.verifyCredential(paired.credential);
        const auditId = yield* service.beginAudit(client, {
          tool: "synara_list_allowed_projects",
        });
        yield* sql`
          CREATE TRIGGER reject_external_mcp_audit_finish
          BEFORE UPDATE ON external_mcp_audit_log
          BEGIN
            SELECT RAISE(FAIL, 'audit finish rejected');
          END
        `;

        const exit = yield* service.finishAudit({ auditId, outcome: "success" }).pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        yield* sql`DROP TRIGGER reject_external_mcp_audit_finish`;
      }),
    );
  });
});
