import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = Path.resolve(import.meta.dirname, "..");
const INDEX_SOURCE = FS.readFileSync(Path.join(WEB_ROOT, "index.html"), "utf8");
const BOOTSTRAP_SOURCE = FS.readFileSync(Path.join(import.meta.dirname, "bootstrap.ts"), "utf8");
const MAIN_SOURCE = FS.readFileSync(Path.join(import.meta.dirname, "main.tsx"), "utf8");

describe("renderer bootstrap ordering", () => {
  it("migrates desktop storage before loading modules that hydrate app stores", () => {
    expect(INDEX_SOURCE).toContain('<script type="module" src="/src/bootstrap.ts"></script>');

    const migrationImportIndex = BOOTSTRAP_SOURCE.indexOf('import "./storageOriginMigration";');
    const signedOutBootstrapIndex = BOOTSTRAP_SOURCE.indexOf("bootstrapSignedOutScreen()");
    const pairingBootstrapIndex = BOOTSTRAP_SOURCE.indexOf("bootstrapPairingSession()");
    const appImportIndex = BOOTSTRAP_SOURCE.indexOf('import("./main")');
    expect(migrationImportIndex).toBeGreaterThanOrEqual(0);
    expect(signedOutBootstrapIndex).toBeGreaterThan(migrationImportIndex);
    expect(pairingBootstrapIndex).toBeGreaterThan(migrationImportIndex);
    expect(pairingBootstrapIndex).toBeGreaterThan(signedOutBootstrapIndex);
    expect(appImportIndex).toBeGreaterThan(migrationImportIndex);
    expect(appImportIndex).toBeGreaterThan(pairingBootstrapIndex);

    expect(MAIN_SOURCE).not.toContain('import "./storageOriginMigration";');
  });
});
