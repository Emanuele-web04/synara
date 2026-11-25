// Billing fixtures own a fresh database, so parallel files cannot erase one another.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runMigrations } from "../db/migrate";

export async function createIsolatedTestDatabase(sourceUrl: string) {
  const admin = new pg.Pool({ connectionString: sourceUrl });
  const name = `synara_billing_test_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(sourceUrl);
  target.pathname = `/${name}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await runMigrations(target.href);
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {});
    await admin.end();
    throw error;
  }
  return {
    url: target.href,
    async close() {
      // Callers close their own pools first; never terminate another test's sessions.
      try {
        await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    },
  };
}
