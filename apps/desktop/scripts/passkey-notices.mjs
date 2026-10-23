import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./native-build-cache.mjs";

export async function writePasskeyNotices(
  manifestPath,
  outputDirectory,
  target,
  force = false,
  title = "Synara phone-passkey helper",
  sourceNotice = "MPL-covered source code, including Synara's user-handle patch, is included in the adjacent source archives.",
) {
  const marker = join(outputDirectory, "licenses.digest");
  const digest = createHash("sha256")
    .update(title)
    .update(sourceNotice)
    .update(readFileSync(join(dirname(manifestPath), "Cargo.lock")))
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(readFileSync(new URL("./build-passkey-helper.mjs", import.meta.url)))
    .digest("hex");
  if (
    !force &&
    existsSync(marker) &&
    existsSync(join(outputDirectory, "THIRD_PARTY_NOTICES.txt")) &&
    readFileSync(marker, "utf8") === digest
  )
    return;
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--manifest-path",
      manifestPath,
      "--format-version",
      "1",
      "--filter-platform",
      target,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error("Could not inventory native passkey dependency licenses.");
  const metadata = JSON.parse(result.stdout);
  const reachable = new Set(metadata.resolve.nodes.map((node) => node.id));
  const packages = metadata.packages.filter((pkg) => reachable.has(pkg.id));
  const licenseIds = new Set(
    packages
      .flatMap((pkg) => (pkg.license ?? "").match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [])
      .filter((name) => !["AND", "OR", "WITH"].includes(name)),
  );
  const texts = await Promise.all(
    [...licenseIds].map(async (id) => {
      const response = await fetch(
        `https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/${id}.txt`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) throw new Error(`Could not retrieve native dependency license ${id}.`);
      const text = await response.text();
      if (text.length > 131072) throw new Error("Native dependency license is too large.");
      return `${id}\n${text}`;
    }),
  );
  const notices = packages.map((pkg) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(pkg.name) || !/^[a-zA-Z0-9.+-]+$/.test(pkg.version))
      throw new Error("Invalid native dependency metadata.");
    const root = dirname(pkg.manifest_path);
    const licenses = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)/i.test(entry.name))
      .map((entry) => readFileSync(join(root, entry.name), "utf8"));
    if (pkg.license?.includes("MPL-2.0")) {
      run("tar", [
        "-czf",
        join(outputDirectory, `source-${pkg.name}-${pkg.version}.tar.gz`),
        "-C",
        dirname(root),
        basename(root),
      ]);
    }
    return `${pkg.name} ${pkg.version}\n${pkg.license ?? "See package license"}\n${pkg.repository ?? ""}\n${licenses.join("\n")}`;
  });
  writeFileSync(
    join(outputDirectory, "THIRD_PARTY_NOTICES.txt"),
    `${title}\n${sourceNotice}\n\n${notices.join("\n\n")}\n\n${texts.join("\n\n")}`,
  );
  writeFileSync(marker, digest);
}
