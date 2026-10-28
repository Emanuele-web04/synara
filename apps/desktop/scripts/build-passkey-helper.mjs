import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./native-build-cache.mjs";
import { writePasskeyNotices } from "./passkey-notices.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(desktop, "native", "passkeys");
const prepared = join(desktop, ".electron-runtime", "passkeys", "webauthn-authenticator-rs");
const archiveDigest = "779e9c80ff248c7e12ea967f909249101f6e86f70fccd742d4b66c490c1710b4";
const version = "0.5.5";

function replaceOnce(path, before, after) {
  const contents = readFileSync(path, "utf8");
  if (contents.split(before).length !== 2)
    throw new Error("The pinned WebAuthn source no longer matches its patch.");
  writeFileSync(path, contents.replace(before, after));
}

export async function preparePasskeySource(force = false) {
  const marker = join(prepared, ".synara-patch-v3");
  if (!force && existsSync(marker)) return;
  const response = await fetch(
    `https://static.crates.io/crates/webauthn-authenticator-rs/webauthn-authenticator-rs-${version}.crate`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error("Could not download the pinned WebAuthn source.");
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== archiveDigest)
    throw new Error("WebAuthn source integrity check failed.");
  rmSync(prepared, { recursive: true, force: true });
  mkdirSync(prepared, { recursive: true });
  const archivePath = join(dirname(prepared), "source.crate");
  writeFileSync(archivePath, archive);
  run("tar", ["-xzf", archivePath, "--strip-components=1", "-C", prepared]);
  rmSync(archivePath);
  const assertion = join(prepared, "src", "ctap2", "commands", "get_assertion.rs");
  replaceOnce(
    assertion,
    "// TODO: pub user: Option<User>,",
    "pub user_handle: Option<Base64UrlSafeData>,",
  );
  replaceOnce(
    assertion,
    "            signature,\n            number_of_credentials,",
    "            signature,\n            user_handle,\n            number_of_credentials,",
  );
  replaceOnce(
    assertion,
    "        if let Some(number_of_credentials) = number_of_credentials {",
    '        if let Some(user_handle) = user_handle {\n            keys.insert(0x04, Value::Map(BTreeMap::from([(Value::Text("id".to_owned()), Value::Bytes(user_handle.into()))])));\n        }\n        if let Some(number_of_credentials) = number_of_credentials {',
  );
  replaceOnce(
    assertion,
    "// TODO: user: None, (0x04)",
    'user_handle: raw.remove(&0x04).and_then(|value| {\n                let Value::Map(mut user) = value else { return None; };\n                user.remove(&Value::Text("id".to_owned())).and_then(|value| value_to_vec_u8(value, "0x04.id")).map(Base64UrlSafeData::from)\n            }),',
  );
  replaceOnce(
    join(prepared, "src", "ctap2", "ctap20.rs"),
    "                // TODO\n                user_handle: None,",
    "                user_handle: ret.user_handle,",
  );
  replaceOnce(
    join(prepared, "src", "ctap2", "ctap20.rs"),
    "        let ret = block_on(self.token.transmit(ga, self.ui_callback))?;",
    "        let ret = block_on(self.token.transmit(ga, self.ui_callback))?;\n        if ret.number_of_credentials.unwrap_or(1) > 1 && ret.user_selected != Some(true) {\n            return Err(WebauthnCError::NotSupported);\n        }",
  );
  replaceOnce(
    join(prepared, "src", "authenticator_hashed.rs"),
    "    let resp = GetAssertionResponse {",
    "    let resp = GetAssertionResponse {\n        user_handle: cred.response.user_handle.clone(),",
  );
  writeFileSync(marker, archiveDigest);
}

export async function buildPasskeyHelper({
  arch = process.arch,
  outputPath,
  prepareOnly = false,
  release = false,
  flavor = process.env.SYNARA_PASSKEY_HELPER_FLAVOR ??
    process.env.SYNARA_DESKTOP_FLAVOR ??
    "development",
} = {}) {
  await preparePasskeySource(release);
  if (prepareOnly) return;
  const targets =
    process.platform === "darwin"
      ? { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" }
      : { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" };
  const selected =
    process.platform === "darwin" && arch === "universal"
      ? Object.values(targets)
      : [targets[arch]];
  if (selected.some((target) => !target) || !["darwin", "linux"].includes(process.platform))
    throw new Error("Unsupported phone-passkey helper build target.");
  if (!["production", "development", "beta", "canary", "cua"].includes(flavor))
    throw new Error("Invalid passkey helper flavor.");
  const targetDir = join(desktop, ".electron-runtime", "passkeys", "target");
  for (const target of selected) {
    run(
      "cargo",
      [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        join(source, "Cargo.toml"),
        "--target-dir",
        targetDir,
        "--target",
        target,
      ],
      { env: { ...process.env, SYNARA_PASSKEY_HELPER_FLAVOR: flavor } },
    );
  }
  const output =
    outputPath ?? join(desktop, ".electron-runtime", "passkeys", "synara-passkey-helper");
  mkdirSync(dirname(output), { recursive: true });
  const binaries = selected.map((target) =>
    join(targetDir, target, "release", "synara-passkey-helper"),
  );
  if (binaries.length > 1) run("lipo", ["-create", ...binaries, "-output", output]);
  else copyFileSync(binaries[0], output);
  chmodSync(output, 0o755);
  if (process.platform === "darwin")
    run("codesign", ["--force", "--sign", "-", "--timestamp=none", output]);
  await writePasskeyNotices(join(source, "Cargo.toml"), dirname(output), selected[0], release);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  await buildPasskeyHelper({
    arch: option("--arch"),
    outputPath: option("--output"),
    prepareOnly: args.includes("--prepare-only"),
    release: args.includes("--release"),
  });
}
