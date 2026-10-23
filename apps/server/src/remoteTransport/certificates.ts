import { withCredentialFileLock } from "../accountCredentialLock";
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  webcrypto,
  X509Certificate,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { createFileStringExclusively, writeFileStringAtomically } from "../atomicWrite";

const DAY = 86_400_000;
const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" };
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface RemoteTlsIdentity {
  readonly version: 2;
  readonly environmentId: string;
  readonly rootCertificate: string;
  readonly rootPrivateKey: string;
  readonly leafCertificate: string;
  readonly leafPrivateKey: string;
}

export interface RemoteTlsAnchor {
  readonly environmentId: string;
  readonly rootCertificate: string;
  readonly rootFingerprint: string;
}

export function remoteTlsIdentityPath(secretsDir: string): string {
  return path.join(secretsDir, "remote-tls.json");
}

export function remoteTlsServerName(environmentId: string): string {
  if (!/^[a-zA-Z0-9-]{1,63}$/.test(environmentId))
    throw new Error("Invalid remote environment identity");
  return `host-${environmentId.toLowerCase()}.synara.invalid`;
}

export function remoteTlsAnchor(identity: RemoteTlsIdentity): RemoteTlsAnchor {
  const root = new X509Certificate(identity.rootCertificate);
  return {
    environmentId: identity.environmentId,
    rootCertificate: identity.rootCertificate,
    rootFingerprint: createHash("sha256")
      .update(root.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
}

export function validateRemoteTlsAnchor(anchor: RemoteTlsAnchor): void {
  remoteTlsServerName(anchor.environmentId);
  const root = new X509Certificate(anchor.rootCertificate);
  const fingerprint = createHash("sha256")
    .update(root.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (!root.ca || !root.verify(root.publicKey) || fingerprint !== anchor.rootFingerprint) {
    throw new Error("Remote root does not match the locally approved fingerprint");
  }
}

export function remoteTlsRootNeedsRepair(identity: RemoteTlsIdentity, now = Date.now()): boolean {
  return Date.parse(new X509Certificate(identity.rootCertificate).validTo) - now <= 180 * DAY;
}

async function exportPrivate(key: webcrypto.CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", key));
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}

async function issueLeaf(
  rootCertificate: string,
  rootPrivateKey: string,
  environmentId: string,
  now: number,
) {
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
  const root = new x509.X509Certificate(rootCertificate);
  const rootKey = await webcrypto.subtle.importKey(
    "pkcs8",
    createPrivateKey(rootPrivateKey).export({ type: "pkcs8", format: "der" }),
    KEY_ALGORITHM,
    false,
    ["sign"],
  );
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(16).toString("hex"),
    subject: `CN=${remoteTlsServerName(environmentId)}`,
    issuer: root.subject,
    publicKey: keys.publicKey as unknown as CryptoKey,
    signingKey: rootKey as unknown as CryptoKey,
    signingAlgorithm: SIGN_ALGORITHM,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(Math.min(now + 90 * DAY, root.notAfter.getTime())),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: remoteTlsServerName(environmentId) },
      ]),
      await x509.AuthorityKeyIdentifierExtension.create(root),
    ],
  });
  return {
    leafCertificate: leaf.toString("pem"),
    leafPrivateKey: await exportPrivate(keys.privateKey),
  };
}

/** Only an explicit local pairing action may create a root. Loading never recreates a lost key. */
async function initializeIdentity(
  filePath: string,
  environmentId: string,
  now = Date.now(),
): Promise<RemoteTlsIdentity> {
  remoteTlsServerName(environmentId);
  try {
    return await loadIdentity(filePath, environmentId, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"),
    name: `CN=Synara ${environmentId} remote root`,
    keys: keys as unknown as CryptoKeyPair,
    signingAlgorithm: SIGN_ALGORITHM,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 3650 * DAY),
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey as unknown as CryptoKey),
    ],
  });
  const rootCertificate = root.toString("pem");
  const rootPrivateKey = await exportPrivate(keys.privateKey);
  const identity: RemoteTlsIdentity = {
    version: 2,
    environmentId,
    rootCertificate,
    rootPrivateKey,
    ...(await issueLeaf(rootCertificate, rootPrivateKey, environmentId, now)),
  };
  const created = await Effect.runPromise(
    createFileStringExclusively({ filePath, contents: JSON.stringify(identity) }),
  );
  return created ? identity : loadIdentity(filePath, environmentId, now);
}

/** Validate persisted keys before renewing; corrupt, expired or mismatched roots fail closed. */
async function loadIdentity(
  filePath: string,
  environmentId: string,
  now = Date.now(),
): Promise<RemoteTlsIdentity> {
  const raw: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("Invalid remote TLS identity");
  const value = raw as RemoteTlsIdentity;
  if (value.version !== 2 || value.environmentId !== environmentId)
    throw new Error("Remote TLS identity belongs to another installation");
  const root = new X509Certificate(value.rootCertificate);
  const leaf = new X509Certificate(value.leafCertificate);
  const rootKey = createPrivateKey(value.rootPrivateKey);
  const leafKey = createPrivateKey(value.leafPrivateKey);
  if (
    !root.ca ||
    !root.verify(root.publicKey) ||
    !root.checkPrivateKey(rootKey) ||
    !leaf.checkPrivateKey(leafKey) ||
    !leaf.verify(root.publicKey) ||
    leaf.ca ||
    !leaf.checkHost(remoteTlsServerName(environmentId)) ||
    rootKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    leafKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    Date.parse(root.validFrom) > now ||
    Date.parse(root.validTo) <= now ||
    Date.parse(leaf.validFrom) > now
  ) {
    throw new Error(
      "Remote TLS identity is invalid or its root expired; local re-pair is required",
    );
  }
  if (Date.parse(leaf.validTo) - now > 30 * DAY) return value;
  const renewed = {
    ...value,
    ...(await issueLeaf(value.rootCertificate, value.rootPrivateKey, environmentId, now)),
  };
  await Effect.runPromise(
    writeFileStringAtomically({ filePath, contents: JSON.stringify(renewed) }),
  );
  return renewed;
}

export function initializeRemoteTlsIdentity(
  filePath: string,
  environmentId: string,
  now = Date.now(),
): Promise<RemoteTlsIdentity> {
  return withCredentialFileLock(filePath, () => initializeIdentity(filePath, environmentId, now));
}
export function loadRemoteTlsIdentity(
  filePath: string,
  environmentId: string,
  now = Date.now(),
): Promise<RemoteTlsIdentity> {
  return withCredentialFileLock(filePath, () => loadIdentity(filePath, environmentId, now));
}
/** Called only after local owner reset has durably revoked every old trust entry. */
export function resetRemoteTlsIdentity(
  filePath: string,
  environmentId: string,
): Promise<RemoteTlsIdentity> {
  return withCredentialFileLock(filePath, async () => {
    try {
      await fs.rename(filePath, `${filePath}.retired-${randomUUID()}`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    return initializeIdentity(filePath, environmentId);
  });
}
