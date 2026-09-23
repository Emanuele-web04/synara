/**
 * The Hyprland installer script (native/computer-use-hyprland/scripts/install-and-load.sh)
 * run for real under bash, with pkg-config, make and g++ stubbed, so no
 * compositor, compiler or real package database is involved.
 */
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInstallScriptSandbox, type InstallScriptSandbox } from "./installScriptSandbox.ts";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "..",
  "native",
  "computer-use-hyprland",
  "scripts",
  "install-and-load.sh",
);

/**
 * pkg-config that knows every module except the ones in $STUB_MISSING. Like
 * the real one, `--exists` is silent about why unless `--print-errors` asks.
 */
const PKG_CONFIG_STUB = String.raw`
module="$(printf '%s\n' "$@" | grep -v '^--' | tail -n 1)"
for missing in $STUB_MISSING; do
    if [[ "$module" == "$missing" ]]; then
        [[ "$*" != *--print-errors* ]] || printf '%s\n' "$STUB_ERROR" >&2
        exit 1
    fi
done
[[ "$*" != *--modversion* ]] || echo "0.56.2"
exit 0
`;

describe("Hyprland install-and-load.sh dependency check (R14)", () => {
  let sandbox: InstallScriptSandbox;

  beforeEach(async () => {
    sandbox = await createInstallScriptSandbox();
    await sandbox.stub("pkg-config", PKG_CONFIG_STUB);
    await sandbox.stub("make", "exit 0");
    await sandbox.stub("g++", "exit 0");
  });

  afterEach(async () => {
    await sandbox.dispose();
  });

  it("names every missing module, with pkg-config's own reason, before building", async () => {
    const result = sandbox.run(SCRIPT, ["--build-only"], {
      STUB_MISSING: "libturbojpeg libpng",
      STUB_ERROR: "Package libturbojpeg was not found in the pkg-config search path.",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("libturbojpeg (Package libturbojpeg was not found");
    expect(result.stderr).toContain("libpng (");
    expect((await sandbox.calls()).filter((call) => call.startsWith("make"))).toEqual([]);
  });

  it("names the module hyprland.pc requires when that is the gap", async () => {
    const result = sandbox.run(SCRIPT, ["--build-only"], {
      STUB_MISSING: "hyprland",
      STUB_ERROR: "Package 'aquamarine', required by 'hyprland', not found",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required by 'hyprland'");
    expect(result.stderr).toContain("/usr/share/pkgconfig/hyprland.pc");
  });
});
